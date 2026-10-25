// A ZcodeTransport backed by a ZCode server (zcode-transport.ts is the stdio
// twin). The driver speaks the app-server request names; the server's
// `zcode-agent` channel offers the same operations with the workspace target
// added, so this renames each request, adds the target, and turns the channel's
// session events and asks back into app-server records. Stopping a turn,
// answering an ask and steering have no channel method, so they go through the
// server's v4 command envelope, as ZCode's own task adapter does.
//
// One transport serves one turn over its own socket. The server keeps the
// session and its agent process; the next turn resumes it.
import { randomBytes } from "node:crypto";

import { appendNative } from "../native.ts";
import {
  ZCODE_DEFAULT_REQUEST_TIMEOUT_MS,
  type ZcodeTransport,
  type ZcodeTransportHandlers,
} from "../zcode-transport.ts";
import { connectZcodeChannel, ZcodeChannelError, type ZcodeChannelClient } from "./channel.ts";

export type SteerResult = "steered" | "refused" | "indeterminate";

export interface ZcodeServerTransport extends ZcodeTransport {
  /** Mid-turn input (`sendText` with guided delivery) into the session's running turn. */
  steer(sessionId: string, text: string): Promise<SteerResult>;
}

export interface ServerTransportOptions {
  endpoint: { url: string; token: string };
  /** The turn's cwd. */
  workspacePath: string;
  /** Names the bot home the server's agent runs under (see agent-wrapper.ts); the server also keys its agent process by it. */
  identity: string;
  threadId: string;
  /** Returns the server lease when the transport closes. */
  release: () => void;
  connect?: typeof connectZcodeChannel;
}

const CLIENT_ID = "legion";
const STOP_GRACE_MS = 10_000;

/** App-server request names and the `zcode-agent` methods that do the same work. */
const AGENT_METHODS: Readonly<Record<string, string>> = {
  "session/create": "createSession",
  "session/resume": "resumeSession",
  "session/send": "sendPrompt",
  "session/setMode": "setMode",
  "session/setModel": "setModel",
  "session/close": "closeSession",
};

interface PendingInteraction {
  kind: "permission" | "userInput";
  options: readonly unknown[];
}

const field = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
const text = (value: unknown, key: string): string | undefined => {
  const found = field(value, key);
  return typeof found === "string" ? found : undefined;
};
const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};

/** uuid v7, which is what ZCode's own host sends as a command id. */
export function uuidv7(now = Date.now()): string {
  const bytes = randomBytes(16);
  let ts = BigInt(now);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A v4 command ack that settled the command (a repeat or a late answer counts as settled). */
export function ackSettled(ack: unknown): boolean {
  const status = text(ack, "status");
  return status === "accepted" || status === "duplicate" || status === "noop";
}

/** The option whose stored response equals the one the driver chose. A hand-made answer (the driver's fallback deny) maps to the first option with that decision. */
export function optionIdForResponse(options: readonly unknown[], response: unknown): string | undefined {
  const wanted = JSON.stringify(response);
  const exact = options.find((option) => JSON.stringify(field(option, "response")) === wanted);
  const decision = text(response, "decision");
  const sameDecision = decision === undefined ? undefined : options.find((option) => text(field(option, "response"), "decision") === decision);
  return text(exact ?? sameDecision, "optionId");
}

/** A channel event or ask as the app-server would have sent it. */
export function serverEventRecord(event: unknown): { kind: "event"; params: unknown } | { kind: "request"; id: string; method: string; params: unknown } | undefined {
  switch (text(event, "type")) {
    case "session.event":
      return { kind: "event", params: field(event, "event") };
    case "permission.request":
    case "userInput.request": {
      const request = field(event, "request");
      const id = text(request, "requestId");
      if (id === undefined) return undefined;
      return {
        kind: "request",
        id,
        method: text(event, "type") === "permission.request" ? "interaction/requestPermission" : "interaction/requestUserInput",
        params: request,
      };
    }
    default:
      return undefined;
  }
}

/** Channel errors carry no remote text by design; give the codes that matter a sentence. */
function failure(method: string, error: unknown): Error {
  if (!(error instanceof ZcodeChannelError)) return error instanceof Error ? error : new Error(String(error));
  const detail = error.detail ?? error.operation;
  if (detail.includes("ZCODE_AGENT_PROVIDER_NOT_READY")) {
    return new Error("ZCode is not signed in or has no usable model (not signed in). Sign in from this engine's settings.");
  }
  return new Error(`ZCode ${method} failed: ${detail}`);
}

export async function openServerTransport(options: ServerTransportOptions, handlers: ZcodeTransportHandlers): Promise<ZcodeServerTransport> {
  const { workspacePath, identity, threadId } = options;
  const client: ZcodeChannelClient = await (options.connect ?? connectZcodeChannel)(options.endpoint).catch((error) => {
    options.release();
    throw failure("connect", error);
  });
  const target = { workspacePath, workspaceIdentity: identity };
  const interactions = new Map<string, PendingInteraction>();
  const disposers: Array<() => void> = [];
  let muted = false;
  let closed = false;
  let sessionId: string | undefined;
  let handshake: Promise<void> | undefined;

  void client.closed.then(() => {
    if (muted || closed) return;
    handlers.failed({ message: "The connection to the ZCode server was lost before turn.completed", stopReason: "connection_lost" });
  });

  const log = (dir: "in" | "out", msg: unknown) => appendNative(threadId, { dir, source: "zcode.server", msg });
  const call = async (channel: string, method: string, args: readonly unknown[]) => {
    try {
      return await client.call(channel, method, args);
    } catch (error) {
      throw failure(method, error);
    }
  };

  /** Remote servers only accept sessions in a project whose single root is the workspace. */
  const ensureProject = async (): Promise<string> => {
    const projects = await call("project", "readProjects", []);
    for (const project of Array.isArray(projects) ? projects : []) {
      const roots = field(project, "roots");
      const id = text(project, "id");
      if (id && Array.isArray(roots) && roots.length === 1 && roots[0] === workspacePath && field(project, "deletedAt") == null) return id;
    }
    const saved = await call("project", "saveProject", [{ roots: [workspacePath] }]);
    const id = text(saved, "id");
    if (!id) throw new Error("ZCode saveProject returned no project id");
    return id;
  };

  // The server refuses v4 commands until the connection has said hello once.
  const sayHello = () =>
    (handshake ??= (async () => {
      const hello = await call("zcode-agent", "helloConversationV4", []);
      await call("zcode-agent", "initializeConversationV4", [
        { kind: "clientHello", protocolVersion: field(hello, "protocolVersion"), clientId: CLIENT_ID, clientKind: "desktop", appVersion: "legion" },
      ]);
    })().catch((error) => {
      handshake = undefined;
      throw error;
    }));

  const command = async (type: "stop" | "resolveInteraction" | "sendText", payload: unknown, session: string | undefined = sessionId) => {
    if (session === undefined) throw new Error(`ZCode ${type} needs a session`);
    await sayHello();
    const envelope = { commandId: uuidv7(), clientId: CLIENT_ID, sessionId: session, type, payload, issuedAt: Date.now() };
    log("out", { method: `v4/${type}`, params: { sessionId: session } });
    return call("zcode-agent", "sendConversationCommandV4", [{ ...target, envelope }]);
  };

  /** A command the server must have settled; anything else is an error for the caller. */
  const settledCommand = async (type: "stop" | "resolveInteraction", payload: unknown, session?: string) => {
    const ack = await command(type, payload, session);
    if (!ackSettled(ack)) throw new Error(`ZCode ${type} failed: ${text(ack, "status") ?? "no ack"}`);
    return ack;
  };

  const subscribe = (params: Record<string, unknown>) => {
    const dispose = client.listen(
      "zcode-agent",
      "onDynamicSessionEvent",
      { ...target, ...params },
      (raw) => {
        if (muted) return;
        const record = serverEventRecord(raw);
        if (record === undefined) return;
        log("in", record.kind === "event" ? { method: "session/event", params: record.params } : { id: record.id, method: record.method });
        if (record.kind === "event") {
          handlers.event(record.params);
          return;
        }
        interactions.set(record.id, record.method === "interaction/requestPermission"
          ? { kind: "permission", options: Array.isArray(field(record.params, "options")) ? field(record.params, "options") as unknown[] : [] }
          : { kind: "userInput", options: [] });
        handlers.serverRequest({ id: record.id, method: record.method, params: record.params });
      },
    );
    disposers.push(dispose);
  };

  const dispatch = async (method: string, params: unknown): Promise<any> => {
    const record = asRecord(params);
    switch (method) {
      case "session/stop":
        return settledCommand("stop", {}, text(record, "sessionId"));
      case "session/subscribe":
        subscribe(record);
        return {};
      case "session/create":
      case "session/resume": {
        const { workspace: _workspace, ...rest } = record;
        const projectId = await ensureProject();
        const snapshot = await call("zcode-agent", AGENT_METHODS[method]!, [{ ...rest, ...target, projectId }]);
        sessionId = text(field(snapshot, "session"), "sessionId") ?? text(record, "sessionId") ?? sessionId;
        return snapshot;
      }
      default: {
        const agentMethod = AGENT_METHODS[method];
        if (agentMethod === undefined) throw new Error(`ZCode ${method} failed: unsupported`);
        const { workspace: _workspace, ...rest } = record;
        return call("zcode-agent", agentMethod, [{ ...rest, ...target }]);
      }
    }
  };

  const terminate = async () => {
    if (closed) return true;
    closed = true;
    for (const dispose of disposers.splice(0)) dispose();
    client.close();
    options.release();
    return true;
  };

  return {
    // The server reports a stopped turn as a cancelled turn.completed event; closing the socket first would lose it.
    stopGraceMs: STOP_GRACE_MS,
    request: (method, params, timeoutMs = ZCODE_DEFAULT_REQUEST_TIMEOUT_MS) => {
      log("out", { method, params });
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`zcode ${method} timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      });
      return Promise.race([dispatch(method, params), timeout]).finally(() => clearTimeout(timer));
    },
    respond: (id, result) => {
      const key = String(id);
      const interaction = interactions.get(key);
      if (interaction === undefined) return;
      interactions.delete(key);
      const answer = interaction.kind === "permission" ? { optionId: optionIdForResponse(interaction.options, result) } : result;
      void settledCommand("resolveInteraction", { interactionId: key, answer }).catch(() => {});
    },
    // Only asks this transport forwards are ever queued, and each is answerable.
    respondError: () => {},
    alive: () => !closed,
    mute: () => {
      muted = true;
    },
    terminate,
    close: async () => {
      muted = true;
      return terminate();
    },
    steer: async (session, input) => {
      let ack: unknown;
      try {
        ack = await command("sendText", { text: input, requestedDelivery: "guide" }, session);
      } catch {
        // The command may have reached the server before the connection failed.
        return "indeterminate";
      }
      return ackSettled(ack) ? "steered" : "refused";
    },
  };
}
