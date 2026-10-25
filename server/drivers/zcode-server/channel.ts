// Client for the ZCode server's WebSocket channel protocol (`/ws`): named channels with request/response
// calls and event subscriptions. Protocol derived from ZCode (zai-org/ZCode), Apache-2.0; minimal re-implementation.
import { WebSocket } from "ws";

import { RequestType, ResponseType, decodeResponse, encodeCancel, encodeRequest, makeFrameDecoder, type ChannelResponse } from "./channel-protocol.ts";

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const MAX_DETAIL_LENGTH = 100;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** `detail` is a fixed category or "Name (code)" from the server, never a remote message or any token. */
export class ZcodeChannelError extends Error {
  operation: string;
  detail?: string;
  constructor(operation: string, detail?: string) {
    super(detail === undefined ? `ZCode channel ${operation} failed` : `ZCode channel ${operation} failed: ${detail}`);
    this.name = "ZcodeChannelError";
    this.operation = operation;
    this.detail = detail;
  }
}

export interface ZcodeChannelClient {
  call(channel: string, method: string, args?: readonly unknown[], options?: { signal?: AbortSignal }): Promise<any>;
  /** Subscribes to a server event. Returns dispose(). onEnd fires once if the socket closes. */
  listen(channel: string, event: string, arg: unknown, onEvent: (value: unknown) => void, onEnd?: (error?: ZcodeChannelError) => void): () => void;
  close(): void;
  readonly closed: Promise<void>;
}

// The server sends `{ name, message, code, ... }`. Only name and a scalar code are kept: messages can carry paths and other data.
function remoteErrorDetail(data: unknown): string {
  if (typeof data !== "object" || data === null) return "remote error";
  const { name, code } = data as { name?: unknown; code?: unknown };
  const label = typeof name === "string" ? name : "remote error";
  const suffix = typeof code === "string" || typeof code === "number" ? ` (${code})` : "";
  return `${label}${suffix}`.slice(0, MAX_DETAIL_LENGTH);
}

function socketErrorDetail(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code.slice(0, MAX_DETAIL_LENGTH) : "connection failed";
}

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: ZcodeChannelError): void;
}
interface Listener {
  onEvent(value: unknown): void;
  onEnd?(error?: ZcodeChannelError): void;
}

export async function connectZcodeChannel(options: { url: string; token: string; connectTimeoutMs?: number }): Promise<ZcodeChannelClient> {
  let target: URL;
  try {
    target = new URL(options.url);
  } catch {
    throw new ZcodeChannelError("connect", "invalid url");
  }
  if (target.protocol !== "ws:" || !LOOPBACK_HOSTS.has(target.hostname)) throw new ZcodeChannelError("connect", "loopback ws url required");
  target.searchParams.set("token", options.token);

  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const ws = new WebSocket(target.toString(), { handshakeTimeout: timeoutMs });
  ws.binaryType = "nodebuffer";

  const calls = new Map<number, PendingCall>();
  const listeners = new Map<number, Listener>();
  let nextId = 0;
  let closedError: ZcodeChannelError | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));
  let resolveInit!: () => void;
  let rejectInit!: (error: ZcodeChannelError) => void;
  let ready = false;
  const initialized = new Promise<void>((resolve, reject) => {
    resolveInit = () => ((ready = true), resolve());
    rejectInit = reject;
  });

  // The first reason wins. Pending calls fail and listeners end exactly once.
  const shutdown = (reason: ZcodeChannelError, terminate = false) => {
    if (terminate && ws.readyState !== WebSocket.CLOSED) ws.terminate();
    if (closedError) return;
    closedError = reason;
    rejectInit(reason);
    const endError = reason.operation === "closed" ? undefined : reason;
    const pendingCalls = [...calls.values()];
    const endedListeners = [...listeners.values()];
    calls.clear();
    listeners.clear();
    for (const pending of pendingCalls) pending.reject(reason);
    for (const listener of endedListeners) listener.onEnd?.(endError);
    resolveClosed();
  };

  const send = (frame: Uint8Array) => {
    if (closedError) throw closedError;
    // A failed write means the socket is unusable; everything pending fails with a fixed category.
    ws.send(frame, (error) => {
      if (error) shutdown(new ZcodeChannelError("send", socketErrorDetail(error)), true);
    });
  };

  const dispatch = (response: ChannelResponse) => {
    if (response.type === ResponseType.Initialize) return resolveInit();
    if (response.type === ResponseType.EventFire) return listeners.get(response.id)?.onEvent(response.data);
    const pending = calls.get(response.id);
    if (!pending) return;
    calls.delete(response.id);
    if (response.type === ResponseType.PromiseSuccess) pending.resolve(response.data);
    else pending.reject(new ZcodeChannelError("call", response.type === ResponseType.PromiseError ? remoteErrorDetail(response.data) : "remote error"));
  };

  const decodeFrames = makeFrameDecoder();
  ws.on("message", (data, isBinary) => {
    if (!isBinary) return;
    try {
      for (const payload of decodeFrames(data as Buffer)) {
        const response = decodeResponse(payload);
        if (response) dispatch(response);
      }
    } catch {
      shutdown(new ZcodeChannelError("decode", "malformed frame"), true);
    }
  });
  // ws error messages can carry the URL (and so the token): keep only the error code.
  ws.on("error", (error) => shutdown(new ZcodeChannelError(ready ? "closed" : "open", socketErrorDetail(error))));
  ws.on("close", () => shutdown(new ZcodeChannelError("closed")));

  const timer = setTimeout(() => shutdown(new ZcodeChannelError("initialize", "timeout"), true), timeoutMs);
  try {
    await initialized;
  } finally {
    clearTimeout(timer);
  }

  return {
    call(channel, method, args = [], callOptions) {
      const signal = callOptions?.signal;
      return new Promise<unknown>((resolve, reject) => {
        if (closedError) return reject(closedError);
        if (signal?.aborted) return reject(new ZcodeChannelError("call", "aborted"));
        const id = nextId++;
        let onAbort: (() => void) | undefined;
        const settle = () => {
          calls.delete(id);
          if (onAbort) signal?.removeEventListener("abort", onAbort);
        };
        calls.set(id, {
          resolve: (value) => (settle(), resolve(value)),
          reject: (error) => (settle(), reject(error)),
        });
        try {
          send(encodeRequest(RequestType.Promise, id, channel, method, args));
        } catch (error) {
          settle();
          return reject(error instanceof ZcodeChannelError ? error : new ZcodeChannelError("encode", "unserializable value"));
        }
        if (!signal) return;
        onAbort = () => {
          if (!calls.has(id)) return;
          settle();
          try {
            send(encodeCancel(RequestType.PromiseCancel, id));
          } catch {
            // closed already: nothing left to cancel
          }
          reject(new ZcodeChannelError("call", "aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
    },
    listen(channel, event, arg, onEvent, onEnd) {
      if (closedError) {
        const error = closedError;
        queueMicrotask(() => onEnd?.(error.operation === "closed" ? undefined : error));
        return () => {};
      }
      const id = nextId++;
      listeners.set(id, { onEvent, onEnd });
      try {
        send(encodeRequest(RequestType.EventListen, id, channel, event, arg));
      } catch (error) {
        const failure = error instanceof ZcodeChannelError ? error : new ZcodeChannelError("encode", "unserializable value");
        if (listeners.delete(id)) queueMicrotask(() => onEnd?.(failure.operation === "closed" ? undefined : failure));
        return () => {};
      }
      return () => {
        if (!listeners.delete(id)) return;
        try {
          send(encodeCancel(RequestType.EventDispose, id));
        } catch {
          // closed already
        }
      };
    },
    close() {
      shutdown(new ZcodeChannelError("closed"));
      ws.close();
    },
    closed,
  };
}
