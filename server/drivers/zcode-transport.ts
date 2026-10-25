// How a ZCode turn talks to its engine. The driver speaks the app-server
// ("ZCode Protocol") request names either to a `zcode app-server` child it owns
// (this file) or to a ZCode server through its channel RPC
// (zcode-server/connection.ts); everything above the seam is shared.
import { describeSpawnFailure, killCliTree, spawnCli } from "../procs.ts";
import { appendNative } from "./native.ts";

export interface ZcodeServerRequest {
  id: unknown;
  method: string;
  params?: unknown;
}

export interface ZcodeTransportFailure {
  message: string;
  /** The turn's settle reason. */
  stopReason: "spawn_error" | "exit_before_result" | "connection_lost";
  setup?: boolean;
}

export interface ZcodeTransportHandlers {
  /** A server→client request (a permission or user-input ask). */
  serverRequest(request: ZcodeServerRequest): void;
  /** A `session/event` notification's params. */
  event(params: unknown): void;
  /** The engine went away before the turn settled. */
  failed(failure: ZcodeTransportFailure): void;
}

export interface ZcodeTransport {
  /** Correlated request; rejects with the engine's error message. */
  request(method: string, params: unknown, timeoutMs?: number): Promise<any>;
  /** Answers a server→client request. */
  respond(id: unknown, result: unknown): void;
  /** Refuses a server→client request so the engine applies its own fallback. */
  respondError(id: unknown, code: number, message: string): void;
  /** False once the engine process or connection is gone. */
  alive(): boolean;
  /** Stops delivering anything to the handlers; the engine may still be winding down. */
  mute(): void;
  /** Stops the engine side without touching pending requests; true once it is fully stopped. */
  terminate(): Promise<boolean>;
  /** Mutes, rejects pending requests and terminates. */
  close(): Promise<boolean>;
}

export const ZCODE_DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export interface StdioTransportOptions {
  cli: string;
  cwd: string;
  env: Record<string, string | undefined>;
  threadId: string;
}

/** One `zcode app-server` process; the owner closes it, it never exits on its own. */
export function openStdioTransport(options: StdioTransportOptions, handlers: ZcodeTransportHandlers): ZcodeTransport {
  const { cli, threadId } = options;
  const child = spawnCli(cli, ["app-server"], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
  let muted = false;
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  const send = (obj: unknown) => {
    try {
      child.stdin.write(JSON.stringify(obj) + "\n");
    } catch {}
    appendNative(threadId, { dir: "out", source: "zcode.app-server", msg: obj });
  };

  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    if (muted) return;
    buf += chunk;
    let nl;
    while (!muted && (nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      appendNative(threadId, { dir: "in", source: "zcode.app-server", msg });
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const entry = pending.get(msg.id);
        if (entry) {
          pending.delete(msg.id);
          if (msg.error) entry.reject(new Error(String(msg.error.message ?? "zcode rpc error")));
          else entry.resolve(msg.result);
        }
      } else if (msg.id !== undefined && msg.method) {
        handlers.serverRequest({ id: msg.id, method: String(msg.method), params: msg.params });
      } else if (msg.method === "session/event") {
        handlers.event(msg.params);
      }
    }
  });

  let stderr = "";
  child.stderr.on("data", (c) => {
    stderr += c;
    if (stderr.length > 8192) stderr = stderr.slice(-8192);
  });
  child.on("error", (e) => {
    if (muted) return;
    handlers.failed({ ...describeSpawnFailure(e, cli), stopReason: "spawn_error" });
  });
  child.on("close", (code, signal) => {
    if (muted) return;
    handlers.failed({
      message: `zcode exited ${code}${signal ? ` (signal ${signal})` : ""} before turn.completed${stderr.trim() ? `: ${stderr.trim().slice(-300)}` : ""}`,
      stopReason: "exit_before_result",
    });
  });

  return {
    request: (method, params, timeoutMs = ZCODE_DEFAULT_REQUEST_TIMEOUT_MS) =>
      new Promise<any>((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`zcode ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
        pending.set(id, {
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        send({ id, method, params });
      }),
    respond: (id, result) => send({ id, result }),
    respondError: (id, code, message) => send({ id, error: { code, message } }),
    alive: () => child.exitCode === null && child.signalCode === null,
    mute: () => {
      muted = true;
    },
    terminate: () => killCliTree(child),
    close: async () => {
      muted = true;
      for (const entry of pending.values()) entry.reject(new Error("turn settled"));
      pending.clear();
      return killCliTree(child);
    },
  };
}
