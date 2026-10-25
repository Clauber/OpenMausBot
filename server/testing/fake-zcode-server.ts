#!/usr/bin/env node
// Fake of the ZCode server (`bin/zcode serve`) for driver tests. It speaks the
// server's binary /ws channel protocol (framing and value tags re-implemented
// here on purpose: a fake must not share code with the client it checks), serves
// the few channels the driver uses, and plays scripted turns as session events.
//
//   FAKE_ZCODE_SERVER_MODE  happy (default) | approval | hold | network-flaky | network-always
//     hold: the turn runs until a guided sendText finishes it or a stop cancels it
//   FAKE_ZCODE_SERVER_DUMP  path to write {calls, listens, env} as JSON
//   FAKE_ZCODE_SERVER_POLLS  pollPendingOAuth answers before the login lands (default 2)
//
// Subcommands: serve | status | stop. Keep this file free of imports from outside
// server/testing — it runs as a bare node subprocess.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";

const command = process.argv[2];
const dataDir = process.env.ZCODE_DATA_BASE_DIR ?? "";
const runDir = join(dataDir, ".zcode", "server", "run");
const statusPath = join(runDir, "status.json");
const dumpPath = process.env.FAKE_ZCODE_SERVER_DUMP;
const mode = process.env.FAKE_ZCODE_SERVER_MODE ?? "happy";

const readStatus = (): Record<string, any> | null => {
  try { return JSON.parse(readFileSync(statusPath, "utf8")); } catch { return null; }
};
const alive = (pid: unknown) => {
  if (typeof pid !== "number") return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

if (command === "status") {
  process.stdout.write(JSON.stringify({ protocolVersion: 1, runningTaskCount: 0, ...(readStatus() ?? { state: "stopped" }) }) + "\n");
  process.exit(0);
}
if (command === "stop") {
  const status = readStatus();
  if (alive(status?.pid)) process.kill(status!.pid, "SIGTERM");
  process.stdout.write(JSON.stringify({ state: "stopped" }) + "\n");
  process.exit(0);
}
if (command !== "serve") {
  process.stdout.write("zcode 0.0.0-fake\n");
  process.exit(0);
}
if (alive(readStatus()?.pid) && readStatus()?.state === "ready") {
  process.stderr.write("Another ZCode Server instance is already running\n");
  process.exit(1);
}

// ── wire protocol (same layout as ZCode's /ws channel) ──────────────────
const Tag = { Undefined: 0, String: 1, Buffer: 2, VSBuffer: 3, Array: 4, Object: 5, Int: 6 };
const enc = new TextEncoder();
const dec = new TextDecoder();
const vql = (value: number): number[] => {
  if (value === 0) return [0];
  const out: number[] = [];
  for (let rest = value; rest !== 0; rest >>>= 7) out.push((rest & 0x7f) | (rest >>> 7 !== 0 ? 0x80 : 0));
  return out;
};
const ser = (out: number[], data: unknown): void => {
  if (data === undefined) out.push(Tag.Undefined);
  else if (typeof data === "string") { const b = enc.encode(data); out.push(Tag.String, ...vql(b.length), ...b); }
  else if (Array.isArray(data)) { out.push(Tag.Array, ...vql(data.length)); for (const e of data) ser(out, e); }
  else if (typeof data === "number" && (data | 0) === data) out.push(Tag.Int, ...vql(data));
  else { const b = enc.encode(JSON.stringify(data) ?? "null"); out.push(Tag.Object, ...vql(b.length), ...b); }
};
const frame = (header: unknown[], body: unknown): Buffer => {
  const payload: number[] = [];
  ser(payload, header);
  ser(payload, body);
  const out = Buffer.alloc(13 + payload.length);
  out.writeUInt8(1, 0);
  out.writeUInt32BE(payload.length, 9);
  Buffer.from(payload).copy(out, 13);
  return out;
};
const des = (bytes: Uint8Array, cursor: { pos: number }): unknown => {
  const readVql = () => {
    let value = 0;
    for (let shift = 0; ; shift += 7) { const b = bytes[cursor.pos++]!; value |= (b & 0x7f) << shift; if ((b & 0x80) === 0) return value; }
  };
  switch (bytes[cursor.pos++]) {
    case Tag.Undefined: return undefined;
    case Tag.String: { const n = readVql(); const s = dec.decode(bytes.subarray(cursor.pos, cursor.pos + n)); cursor.pos += n; return s; }
    case Tag.Array: { const n = readVql(); const out: unknown[] = []; for (let i = 0; i < n; i++) out.push(des(bytes, cursor)); return out; }
    case Tag.Object: { const n = readVql(); const v = JSON.parse(dec.decode(bytes.subarray(cursor.pos, cursor.pos + n))); cursor.pos += n; return v; }
    case Tag.Int: return readVql();
    default: throw new Error("tag");
  }
};
const decodeFrames = () => {
  let pending = Buffer.alloc(0);
  return (chunk: Buffer): Uint8Array[] => {
    pending = Buffer.concat([pending, chunk]);
    const out: Uint8Array[] = [];
    while (pending.length >= 13) {
      const length = pending.readUInt32BE(9);
      if (pending.length < 13 + length) break;
      if (pending.readUInt8(0) === 1 && length > 0) out.push(pending.subarray(13, 13 + length));
      pending = pending.subarray(13 + length);
    }
    return out;
  };
};

// ── fake server state ───────────────────────────────────────────────────
const token = randomBytes(16).toString("hex");
const dump = { calls: [] as Array<{ channel: string; method: string; args: unknown }>, listens: [] as unknown[], env: Object.fromEntries(["HOME", "ZCODE_DATA_BASE_DIR", "ZCODE_AGENT_SERVER_COMMAND"].map((k) => [k, process.env[k]])) };
const writeDump = () => { if (dumpPath) writeFileSync(dumpPath, JSON.stringify(dump)); };

interface Listener { ws: WebSocket; id: number; event: string; arg: any }
const listeners = new Set<Listener>();
let nextSession = 1;
let sends = 0;
let nextSeq = 1;
let polls = 0;
const handshaken = new WeakSet<WebSocket>();
const credentialsPath = join(dataDir, ".zcode", "v2", "credentials.json");

const fire = (sessionId: string, body: unknown) => {
  for (const l of listeners) {
    if (l.event === "onDynamicSessionEvent" && l.arg?.sessionId === sessionId) l.ws.send(frame([204, l.id], body));
  }
};
const sessionEvent = (sessionId: string, type: string, payload: Record<string, unknown>) =>
  fire(sessionId, { type: "session.event", event: { deliveryKind: "desktop-continuous", eventId: `fake-${nextSeq}`, seq: nextSeq++, sessionId, type, payload } });

const completionTail = (sessionId: string, resultType = "success", response = "Hello") => {
  sessionEvent(sessionId, "model.streaming", { kind: "tool_call", toolCallId: "call_1", toolName: "Bash", input: { command: "ls", cwd: "/tmp" } });
  sessionEvent(sessionId, "tool.updated", { kind: "scheduled", toolCallId: "call_1", toolName: "Bash", inputOmitted: true });
  sessionEvent(sessionId, "tool.updated", { kind: "result", toolCallId: "call_1", toolName: "Bash", result: { success: true, content: "files" } });
  sessionEvent(sessionId, "turn.completed", { response, resultType, usage: { inputTokens: 100, outputTokens: 7, cacheReadTokens: 40 } });
};
const scriptedTurn = (sessionId: string) => {
  sessionEvent(sessionId, "model.streaming", { kind: "text_delta", delta: "Hel", done: false, assistantMessageId: "m1" });
  sessionEvent(sessionId, "model.streaming", { kind: "text_delta", delta: "lo", done: false, assistantMessageId: "m1" });
  setTimeout(() => completionTail(sessionId), 20);
};
const OPTIONS = [
  { optionId: "allow-1", kind: "allow_once", name: "Allow", response: { decision: "allow", reason: "Approved once" } },
  { optionId: "deny-1", kind: "deny", name: "Deny", response: { decision: "deny", reason: "Denied" } },
];

const MODEL_VIEW = {
  revision: 1,
  providers: [
    { providerId: "account:zai-start-plan", providerName: "Start Plan", models: [{ modelId: "GLM-5.3-Flash", config: { optionSpecs: { reasoningLevel: { values: ["low", "high", "max"] } } } }] },
    { providerId: "account:zai-individual-coding-plan", providerName: "Z.ai Individual", models: [{ modelId: "GLM-5.3", config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } } }] },
  ],
  preferredSelection: { providerId: "account:zai-start-plan", modelId: "GLM-5.3-Flash", options: { reasoningLevel: "high" } },
};
const PROVIDER_VIEW = {
  providers: [
    { providerId: "account:zai-individual-coding-plan", accountState: { entitled: true } },
    { providerId: "account:zai-start-plan", accountState: { entitled: true } },
  ],
};

function handle(ws: WebSocket, channel: string, method: string, args: any[]): unknown {
  switch (`${channel}.${method}`) {
    case "project.readProjects": return [];
    case "project.saveProject": return { id: "project-1" };
    case "model-selection.getView": return MODEL_VIEW;
    case "provider-settings.refresh": return {};
    case "provider-settings.getView": return PROVIDER_VIEW;
    case "setting.get": return {};
    case "setting.update": return {};
    case "oauth.startOAuthWithPolling": polls = 0; return { authorizeUrl: "https://chat.z.ai/api/oauth/authorize?state=fake" };
    case "oauth.pollPendingOAuth": {
      polls += 1;
      if (polls <= Number(process.env.FAKE_ZCODE_SERVER_POLLS ?? "2")) return null;
      mkdirSync(join(dataDir, ".zcode", "v2"), { recursive: true });
      writeFileSync(credentialsPath, JSON.stringify({ "oauth:zai:access_token": "x" }));
      return { kind: "session" };
    }
    case "oauth.cancelPending": return {};
    case "oauth.logout": writeFileSync(credentialsPath, "{}"); return {};
    case "zcode-agent.helloConversationV4": handshaken.add(ws); return { protocolVersion: 4 };
    case "zcode-agent.initializeConversationV4": return undefined;
    case "zcode-agent.createSession": {
      const sessionId = `session_fake_${nextSession++}`;
      return { session: { sessionId, mode: args[0]?.mode } };
    }
    case "zcode-agent.resumeSession": return { session: { sessionId: args[0]?.sessionId } };
    case "zcode-agent.setMode":
    case "zcode-agent.setModel":
    case "zcode-agent.closeSession": return {};
    case "zcode-agent.sendPrompt": {
      sends += 1;
      const sessionId = args[0].sessionId as string;
      sessionEvent(sessionId, "turn.started", { input: args[0].content });
      setTimeout(() => {
        if (mode === "network-always" || (mode === "network-flaky" && sends === 1)) {
          sessionEvent(sessionId, "turn.failed", { error: { type: "model_request_failed", message: "model request failed", code: "model_request_failed", attribution: { reason: "network_error" } } });
        } else if (mode === "approval") {
          for (const l of listeners) {
            if (l.event === "onDynamicSessionEvent" && l.arg?.sessionId === sessionId) {
              l.ws.send(frame([204, l.id], { type: "permission.request", request: { requestId: "perm-1", toolCallId: "call_1", toolName: "Bash", input: { command: "ls", cwd: "/tmp" }, options: OPTIONS } }));
            }
          }
        } else if (mode === "hold") {
          sessionEvent(sessionId, "model.streaming", { kind: "text_delta", delta: "working", done: false, assistantMessageId: "m1" });
        } else scriptedTurn(sessionId);
      }, 20);
      return { accepted: true, inputId: "in-1" };
    }
    case "zcode-agent.sendConversationCommandV4": {
      if (!handshaken.has(ws)) throw Object.assign(new Error("fault.connection.handshakeRequired"), { code: undefined });
      const envelope = args[0]?.envelope;
      const sessionId = envelope?.sessionId as string;
      if (envelope?.type === "stop") setTimeout(() => sessionEvent(sessionId, "turn.completed", { response: "", resultType: "cancelled" }), 10);
      else if (envelope?.type === "resolveInteraction") setTimeout(() => completionTail(sessionId), 10);
      else if (envelope?.type === "sendText" && envelope.payload?.requestedDelivery === "guide") setTimeout(() => completionTail(sessionId, "success", `Steered: ${envelope.payload.text}`), 10);
      return { status: "accepted", commandId: envelope?.commandId };
    }
    default: throw new Error(`Method not found: ${channel}.${method}`);
  }
}

mkdirSync(runDir, { recursive: true });
const server = new WebSocketServer({ host: "127.0.0.1", port: 0, verifyClient: (info: { req: { url?: string } }) => (info.req.url ?? "").includes(`token=${token}`) });
server.on("connection", (ws) => {
  ws.send(frame([200], undefined));
  const decode = decodeFrames();
  ws.on("message", (data: Buffer) => {
    for (const payload of decode(data)) {
      const cursor = { pos: 0 };
      const header = des(payload, cursor) as any[];
      const body = des(payload, cursor) as any;
      const [type, id, channel, name] = header;
      if (type === 100) {
        dump.calls.push({ channel, method: name, args: body });
        writeDump();
        try {
          ws.send(frame([201, id], handle(ws, channel, name, body ?? [])));
        } catch (error) {
          ws.send(frame([202, id], { name: "Error", message: error instanceof Error ? error.message : String(error), code: "FAKE" }));
        }
      } else if (type === 102) {
        listeners.add({ ws, id, event: name, arg: body });
        dump.listens.push({ channel, event: name, arg: body });
        writeDump();
      } else if (type === 103) {
        for (const l of listeners) if (l.ws === ws && l.id === id) listeners.delete(l);
      }
    }
  });
  ws.on("close", () => { for (const l of listeners) if (l.ws === ws) listeners.delete(l); });
});
server.on("listening", () => {
  const port = (server.address() as { port: number }).port;
  writeFileSync(join(runDir, "ingress-token"), token, { mode: 0o600 });
  writeFileSync(statusPath, JSON.stringify({ protocolVersion: 1, state: "ready", pid: process.pid, host: "127.0.0.1", port, version: "3.16.2" }));
  process.stdout.write(`ZCode Server ready at 127.0.0.1:${port}\n`);
});
const stopped = () => {
  writeFileSync(statusPath, JSON.stringify({ protocolVersion: 1, state: "stopped", pid: null, host: null, port: null, version: "3.16.2" }));
  process.exit(0);
};
process.on("SIGTERM", stopped);
process.on("SIGINT", stopped);
