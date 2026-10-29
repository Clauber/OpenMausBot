#!/usr/bin/env node
// Fake of the zcode CLI's `app-server` ("ZCode Protocol") surface, for
// driver tests. Speaks newline-delimited {id, method, params} JSON on
// stdio — no `jsonrpc` field, matching the real protocol. Turns run over
// v4: `v4/command` createSession / sendText / stop / resolveInteraction /
// switchModelConfig, `v4/conversation/subscribe` and conversation frames.
// The catalog probe's v1 session/* calls and v1 `session/resume` stay. Like
// the real app-server, it never exits on its own; the driver kills it.
//
//   FAKE_ZCODE_MODE  happy (default) | approval (a permission ask, re-announced
//                    on the v1 channel like 0.16.9 does) | approval-no-allow
//                    (only allowAlways and deny offered) | question |
//                    resume-refused | exit-mid-turn | hold (runs until stopped) |
//                    network-flaky (first turn fails on a dropped provider
//                    stream) | network-always | refused-401 |
//                    narrate (text, a command, more text in two more messages) |
//                    announce* | reply-question | reply-long
//   FAKE_ZCODE_DUMP  path to write {pid, calls, answers, v1Replies, env} as JSON
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { writeFileSync } from "node:fs";

const mode = process.env.FAKE_ZCODE_MODE ?? "happy";
const dumpPath = process.env.FAKE_ZCODE_DUMP;

// The driver's snapshot probe runs `<cli> version` and expects a line on
// stdout and a clean exit, like the real CLI.
if (process.argv.slice(2).includes("version")) {
  process.stdout.write("zcode 0.0.0-fake\n");
  process.exit(0);
}

// Follow the spawning server down, including on Windows where ppid does
// not change after parent exit. Inline: fakes must stay self-contained.
{
  const spawner = process.ppid;
  const orphanWatch = setInterval(() => {
    if (process.ppid !== spawner) process.exit(0);
    try { process.kill(spawner, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") process.exit(0);
    }
  }, 500);
  orphanWatch.unref();
}

const dump = {
  pid: process.pid,
  calls: [] as Array<{ id: unknown; method: string; params: unknown }>,
  answers: {} as Record<string, unknown>,
  /** Replies to the v1 `interaction/*` requests. A v4 client must leave them unanswered. */
  v1Replies: {} as Record<string, unknown>,
  env: Object.fromEntries(["HOME", "ZCODE_DATA_BASE_DIR", "ZCODE_STORAGE_DIR", "ZCODE_SESSION_DB_PATH"].map((key) => [key, process.env[key]])),
};
const writeDump = () => {
  if (dumpPath) writeFileSync(dumpPath, JSON.stringify(dump));
};
const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id: unknown, result: unknown) => send({ id, result });
const fail = (id: unknown, code: number, message: string) => send({ id, error: { code, message } });

type Row = Record<string, unknown> & { rowId: number; turnId: string; kind: string };
type Interaction = Record<string, unknown> & { interactionId: string };

let sessionId = "sess_fake_1";
let subscriptionId = "";
let seq = 0;
let revision = 1;
let lastRowId = 0;
let turnNo = 0;
let sentTurns = 0;
let nextRequestId = 100;
const rows: Row[] = [];
const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
let pending: Interaction[] = [];
let running: { turnId: string; headerId: number; onAnswer?: (answer: Record<string, unknown>) => void } | null = null;
let sessionConfig: Record<string, unknown> = { provider: "zai-fake", model: "glm-5.3-flash", thought: "max", thoughtLevels: ["low", "max"], followupMode: "queue", mode: "build" };

const control = (phase: string, lastError: unknown = null) => ({ phase, canStop: phase === "running", activeWorks: [], lastError });
const snapshotState = () => ({
  sessionId, logEpoch: "epoch-1", revision, control: control(running ? "running" : "completedSuccess"),
  inputRouting: { mode: "startNow" }, meta: { title: "", titleSource: "none" }, availability: {}, config: sessionConfig,
  usage: { contextWindow: null, cumulative: { ...usage } }, queue: { items: [], autoDrain: true }, plan: null,
  subagents: { revision: 0, childSessionIds: [], running: [], endedTotal: 0 }, backgroundWorks: [], pendingInteractions: pending,
  goal: null, rows: { window: rows, totalCount: rows.length, firstRowId: rows[0]?.rowId ?? null },
});
const frame = (payload: unknown, advance = true) => {
  const fromSeq = seq;
  if (advance) seq += 1;
  send({ method: "v4/conversation/frame", params: { kind: "complete", frame: { topic: `conversation/${sessionId}`, subscriptionId, fromSeq, toSeq: seq, sentAt: Date.now(), payload } } });
};
const deltas = (...list: unknown[]) => frame({ kind: "deltas", deltas: list });
const patch = (fields: Record<string, unknown>) => ({ op: "state.updated", patch: fields });
const stored = (rowId: number) => rows.find((row) => row.rowId === rowId)!;
const upsert = (row: Row) => {
  const index = rows.findIndex((existing) => existing.rowId === row.rowId);
  if (index < 0) rows.push(row);
  else rows[index] = row;
  return { op: index < 0 ? "row.appended" : "row.upserted", row: structuredClone(row) };
};
const newRow = (turnId: string, kind: string, fields: Record<string, unknown>) =>
  upsert({ rowId: ++lastRowId, entityId: `e${lastRowId}`, turnId, createdAt: Date.now(), kind, ...fields });
const textDelta = (rowId: number, text: string) => {
  const row = stored(rowId);
  row.text = `${row.text ?? ""}${text}`;
  return { op: "row.delta", rowId, path: "text", append: text };
};
const say = (turnId: string, parts: string[]) => {
  const appended = newRow(turnId, "assistantText", { text: "", state: "streaming" });
  deltas(appended, ...parts.map((part) => textDelta(appended.row.rowId, part)));
  deltas(upsert({ ...stored(appended.row.rowId), state: "complete" }));
};
const tool = (turnId: string, toolCallId: string, toolName: string, input: unknown, status: string, output?: string) =>
  newRow(turnId, "toolCall", { toolCallId, toolName, status, input, ...(output === undefined ? {} : { output: { text: output } }) });
const setTool = (toolCallId: string, status: string, output?: string) => {
  const row = rows.find((candidate) => candidate.kind === "toolCall" && candidate.toolCallId === toolCallId)!;
  return upsert({ ...row, status, ...(output === undefined ? {} : { output: { text: output } }) });
};

const startTurn = (inputId: string, text: string, attachments?: unknown) => {
  const turnId = `turn-${++turnNo}`;
  const header = newRow(turnId, "turnHeader", { state: "running" });
  deltas(header, newRow(turnId, "userInput", { text, sourceCommandId: inputId, ...(attachments ? { attachments } : {}) }), patch({ control: control("running") }));
  running = { turnId, headerId: header.row.rowId };
  return turnId;
};
const endTurn = (state: "completedSuccess" | "completedInterrupted" | "failed", spent?: Partial<typeof usage>, lastError?: unknown) => {
  if (!running) return;
  const header = stored(running.headerId);
  running = null;
  for (const [key, value] of Object.entries(spent ?? {})) usage[key as keyof typeof usage] += value ?? 0;
  deltas(
    patch({ usage: { contextWindow: null, cumulative: { ...usage } }, control: control(state === "failed" ? "error" : state, lastError ?? null) }),
    upsert({ ...header, state }),
  );
};
const SPENT = { inputTokens: 100, outputTokens: 7, cacheReadTokens: 40 };

const happyTurn = (turnId: string) => {
  const reasoning = newRow(turnId, "reasoning", { text: "", state: "streaming" });
  deltas(reasoning, textDelta(reasoning.row.rowId, "thinking "));
  say(turnId, ["Hel", "lo"]);
  setTimeout(() => {
    deltas(tool(turnId, "call_1", "Bash", { command: "ls", cwd: "/tmp" }, "running"));
    deltas(setTool("call_1", "success", "files"));
    deltas(tool(turnId, "call_2", "Read", { file_path: "/tmp/missing" }, "error", "no such file"));
    endTurn("completedSuccess", SPENT);
  }, 20);
};

// Interim commentary: the model says what it will do, runs it, then answers in two more messages.
const narratedTurn = (turnId: string) => {
  say(turnId, ["Checking ", "the files."]);
  deltas(tool(turnId, "call_1", "Bash", { command: "ls" }, "running"));
  setTimeout(() => {
    deltas(setTool("call_1", "success", "files"));
    say(turnId, ["Found ", "two."]);
    say(turnId, [" Done."]);
    endTurn("completedSuccess", { inputTokens: 1, outputTokens: 1 });
  }, 20);
};

// 0.16.9 asks on both channels: a v1 server request (about 100 ms first, re-announced under new ids) and a v4 pending
// interaction with the same id. Only the v4 answer may resolve it.
const ask = (turnId: string, interaction: Interaction, v1Method: string, v1Params: Record<string, unknown>) => {
  const announce = () => send({ id: `srv-${nextRequestId++}`, method: v1Method, params: { ...v1Params, requestId: interaction.interactionId } });
  announce();
  pending = [interaction];
  deltas(patch({ pendingInteractions: pending }));
  const repeats = setInterval(() => (pending.length ? announce() : clearInterval(repeats)), 30);
  running!.onAnswer = (answer) => {
    clearInterval(repeats);
    pending = [];
    const allowed = answer.optionId === "allowOnce" || answer.action === "accept";
    const answered = answer.action === "accept" ? JSON.stringify(answer.content) : "ran";
    deltas(patch({ pendingInteractions: [] }), setTool("call_1", allowed ? "success" : "cancelled", allowed ? answered : undefined));
    setTimeout(() => {
      say(turnId, [allowed ? "Done." : "Skipped."]);
      endTurn("completedSuccess", SPENT);
    }, 20);
  };
};
const PERMISSION_OPTIONS = {
  allowOnce: { optionId: "allowOnce", label: "Allow once", kind: "allowOnce", response: { decision: "allow", reason: "Approved once" } },
  allowAlways: { optionId: "allowAlways", label: "Always allow in this project", kind: "allowAlways", response: { decision: "allow", reason: "Approved for this project" } },
  deny: { optionId: "deny", label: "Deny", kind: "deny", response: { decision: "deny" } },
};
const permissionTurn = (turnId: string, offered: Array<keyof typeof PERMISSION_OPTIONS>) => {
  const command = offered.includes("allowOnce") ? "ls" : "rm -rf /";
  const row = tool(turnId, "call_1", "Bash", { command, cwd: "/tmp" }, "pendingApproval");
  deltas(row);
  const options = offered.map((key) => PERMISSION_OPTIONS[key]);
  ask(turnId, {
    interactionId: `perm_${turnId}`, kind: "permission", anchorRowId: row.row.rowId, createdAt: Date.now(),
    payload: { kind: "permission", toolCallId: "call_1", toolName: "Bash", summary: "High risk tools require explicit approval", detail: { command, cwd: "/tmp" }, freeText: true, options },
  }, "interaction/requestPermission", { toolCallId: "call_1", toolName: "Bash", reason: "High risk tools require explicit approval", input: { command, cwd: "/tmp" }, options });
};
const questionTurn = (turnId: string) => {
  const questions = [{ question: "Pick one", header: "Pick", options: [{ value: "alpha", label: "alpha" }, { value: "beta", label: "beta" }] }];
  const row = tool(turnId, "call_1", "AskUserQuestion", { questions }, "pendingApproval");
  deltas(row);
  ask(turnId, {
    interactionId: `perm_q_${turnId}`, kind: "userInput", anchorRowId: row.row.rowId, createdAt: Date.now(),
    payload: { kind: "userInput", prompt: "Tool AskUserQuestion requires user interaction", freeText: true, toolCallId: "call_1", toolName: "AskUserQuestion", input: { questions }, schema: { toolName: "AskUserQuestion" }, questions },
  }, "interaction/requestUserInput", { prompt: "Tool AskUserQuestion requires user interaction", toolCallId: "call_1", toolName: "AskUserQuestion", questions });
};

const failedTurn = (attribution: Record<string, unknown>) =>
  endTurn("failed", undefined, { type: "model_request_failed", message: "model request failed", code: "model_request_failed", attribution });

const playTurn = (turnId: string, text: string) => {
  if (mode.startsWith("announce") || mode === "reply-question" || mode === "reply-long") {
    const response = mode === "reply-question" ? "Now let me run the tests?"
      : mode === "reply-long" ? "Now let me run the tests. " + "Finished work. ".repeat(40)
      : sentTurns === 1 || mode === "announce-twice" ? "Now let me run the tests."
      : `Done — received: ${text}`;
    say(turnId, [response]);
    endTurn(mode === "announce-cancelled" ? "completedInterrupted" : "completedSuccess", SPENT);
    return;
  }
  if (mode === "network-always" || (mode === "network-flaky" && sentTurns === 1)) return failedTurn({ reason: "network_error" });
  if (mode === "refused-401") return failedTurn({ reason: "unauthorized", statusCode: 401 });
  if (mode === "approval") return permissionTurn(turnId, ["allowOnce", "allowAlways", "deny"]);
  if (mode === "approval-no-allow") return permissionTurn(turnId, ["allowAlways", "deny"]);
  if (mode === "question") return questionTurn(turnId);
  if (mode === "narrate") return narratedTurn(turnId);
  if (mode === "hold") return;
  happyTurn(turnId);
};

const ack = (params: any, result?: unknown, status = "accepted") => {
  const decided = revision;
  revision += 1;
  return { commandId: params.commandId, status, revisionAtDecision: decided, ...(status === "accepted" ? {} : { reasonCode: "fake.refused" }), ...(result ? { result } : {}) };
};
const announceRevision = () => {
  if (subscriptionId) deltas(patch({ revision }));
};

const command = (msg: any) => {
  const params = msg.params ?? {};
  const payload = params.payload ?? {};
  switch (params.type) {
    case "createSession":
      reply(msg.id, ack(params, { type: "createSession", sessionId }));
      if (payload.config?.mode) sessionConfig = { ...sessionConfig, mode: payload.config.mode };
      return;
    case "sendText": {
      sentTurns += 1;
      if (mode === "announce-rejected" && sentTurns === 2) return reply(msg.id, ack(params, undefined, "rejected"));
      reply(msg.id, ack(params, { type: "inputAccepted", delivery: "startNow", inputId: params.commandId }));
      if (mode === "exit-mid-turn") {
        process.stderr.write("synthetic mid-turn crash\n");
        process.exit(1);
      }
      const turnId = startTurn(params.commandId, payload.text, payload.attachments);
      setTimeout(() => playTurn(turnId, payload.text), 20);
      return;
    }
    case "stop":
      reply(msg.id, ack(params));
      if (running) {
        pending = [];
        deltas(patch({ pendingInteractions: [] }));
        endTurn("completedInterrupted");
      }
      return;
    case "resolveInteraction":
      dump.answers[payload.interactionId] = payload.answer;
      writeDump();
      reply(msg.id, ack(params));
      if (pending.some((interaction) => interaction.interactionId === payload.interactionId)) running?.onAnswer?.(payload.answer);
      return;
    case "switchModelConfig": {
      const known = FAKE_MODELS.some((option) => option.ref.providerId === payload.provider && option.ref.modelId === payload.model);
      if (!known) return reply(msg.id, ack(params, undefined, "failed"));
      reply(msg.id, ack(params));
      sessionConfig = { ...sessionConfig, provider: payload.provider, model: payload.model, thought: payload.thought };
      return deltas(patch({ revision, config: sessionConfig }));
    }
    default:
      reply(msg.id, ack(params));
      announceRevision();
  }
};

// The model registry the fake serves in catalog mode: one model that
// requires a reasoning level, matching the real headless registry's shape.
const FAKE_MODELS = [
  {
    ref: { providerId: "zai-fake", modelId: "glm-5.3-flash" },
    label: "glm-5.3-flash",
    providerLabel: "Z.AI Fake",
    contextWindow: 200000,
    reasoning: { levels: [{ value: "low", label: "low" }, { value: "max", label: "max" }], defaultLevel: "max" },
  },
];
let sessionModel = { providerId: "zai-fake", modelId: "glm-5.3-flash", options: { reasoningLevel: "max" } };
const settingsSnapshot = (include: boolean) => include
  ? { snapshot: { settings: { model: { current: sessionModel, available: FAKE_MODELS.map((o) => ({ ...o, properties: { inputFormat: {}, outputFormat: {} } })) } } } }
  : {};
const sessionResult = (sessionId: string, mode: unknown, params: any = {}) => ({
  messages: [],
  projection: { sessionId: "unknown", status: "idle", mode },
  protocol: { name: "ZCode Protocol", version: 1 },
  runtime: { eventSeq: 0 },
  ...settingsSnapshot(params.includeSnapshot === true),
  session: { sessionId, mode, model: sessionModel },
  ...(params.persistence !== undefined ? { persistence: params.persistence } : {}),
});

let buffer = "";
process.stdin.on("end", () => process.exit(0));
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    let msg: any;
    try { msg = JSON.parse(line); } catch { continue; }

    if (msg.method === undefined && typeof msg.id === "string" && msg.id.startsWith("srv-")) {
      dump.v1Replies[msg.id] = msg.result ?? msg.error;
      writeDump();
      continue;
    }
    if (msg.method === undefined) continue;

    dump.calls.push({ id: msg.id, method: msg.method, params: msg.params });
    // A rejected request can make the driver stop this process immediately.
    writeDump();
    switch (msg.method) {
      case "session/create":
        reply(msg.id, sessionResult("sess_fake_1", msg.params?.mode, msg.params));
        break;
      case "session/resume":
        if (mode === "resume-refused") fail(msg.id, -32602, "no such session");
        else {
          sessionId = msg.params.sessionId;
          reply(msg.id, sessionResult(sessionId, msg.params?.mode, msg.params));
        }
        break;
      case "session/setMode":
        reply(msg.id, {});
        break;
      case "session/setModel": {
        const selection = msg.params?.model;
        const modelId = typeof selection?.modelId === "string" ? selection.modelId : "";
        const known = FAKE_MODELS.some((o) => o.ref.modelId === modelId);
        if (!known) fail(msg.id, -32603, `Provider Registry 中不存在 Model: ${JSON.stringify(selection)}`);
        else if (modelId === "glm-5.3-flash" && selection?.options?.reasoningLevel === undefined) {
          fail(msg.id, -32603, `Reasoning level is required for ${selection.providerId}/${modelId}`);
        } else {
          sessionModel = selection;
          reply(msg.id, {});
        }
        break;
      }
      case "session/close":
        reply(msg.id, {});
        break;
      case "session/subscribe":
        reply(msg.id, {
          sessionId: msg.params?.sessionId,
          eventSeq: 0,
          events: [],
          ...settingsSnapshot(msg.params?.includeSnapshot === true),
        });
        break;
      case "v4/command":
        command(msg);
        break;
      case "v4/conversation/subscribe":
        subscriptionId = "sub-1";
        reply(msg.id, { ack: { subscriptionId, mode: "snapshot", logEpoch: "epoch-1" } });
        frame({ kind: "snapshot", snapshot: snapshotState() }, false);
        break;
      case "v4/conversation/unsubscribe":
        reply(msg.id, {});
        break;
      case "v4/attachment/begin":
        reply(msg.id, { uploadId: msg.params?.uploadId, state: "staging", nextChunkIndex: 0 });
        break;
      case "v4/attachment/chunk":
        reply(msg.id, { uploadId: msg.params?.uploadId, nextChunkIndex: (msg.params?.chunkIndex ?? 0) + 1 });
        break;
      case "v4/attachment/commit":
        reply(msg.id, { ref: `zcode-artifact://${sessionId}/upload-${msg.params?.uploadId}` });
        break;
      default:
        fail(msg.id, -32601, `Unsupported server request: ${msg.method}`);
    }
  }
});
