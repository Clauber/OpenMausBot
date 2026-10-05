#!/usr/bin/env node
// Fake of the zcode CLI's `app-server` ("ZCode Protocol") surface, for
// driver tests. Speaks newline-delimited {id, method, params} JSON on
// stdio — no `jsonrpc` field, matching the real protocol — answers the
// session/create (or resume) → subscribe → send handshake, then plays a
// scripted turn of session/event notifications. Like the real app-server,
// it never exits on its own; the driver kills it.
//
//   FAKE_ZCODE_MODE  happy (default) | approval | approval-no-allow |
//                    question | resume-refused | exit-mid-turn
//   FAKE_ZCODE_DUMP  path to write {pid, calls, answers} as JSON
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
};
const writeDump = () => {
  if (dumpPath) writeFileSync(dumpPath, JSON.stringify(dump));
};
const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id: unknown, result: unknown) => send({ id, result });
const fail = (id: unknown, code: number, message: string) => send({ id, error: { code, message } });

let nextSeq = 1;
// Wire shape (verified against a live app-server): the discriminator is
// params.type and the member data rides params.payload — the schema union's
// members describe the payload, not a type-tagged payload object.
const event = (type: string, payload: Record<string, unknown>) =>
  send({
    method: "session/event",
    params: {
      deliveryKind: "desktop-continuous",
      eventId: `fake-${nextSeq}`,
      type,
      payload,
      seq: nextSeq++,
      sessionId: "sess_fake_1",
    },
  });

const completionTail = () => {
  event("tool.updated", { kind: "started", toolCallId: "call_1", toolName: "Bash", input: { command: "ls", cwd: "/tmp" } });
  event("tool.updated", { kind: "result", toolCallId: "call_1", toolName: "Bash", result: { success: true, content: "files" } });
  event("turn.completed", {
    response: "Hello",
    tokenCount: 5,
    usage: { source: "provider", modelRequestCount: 1, inputTokens: 100, outputTokens: 7, cacheReadTokens: 40 },
    toolCallCount: 1,
    duration: 1.5,
    resultType: "success",
  });
};

const scriptedTurn = () => {
  event("model.streaming", { kind: "reasoning_delta", delta: "thinking ", done: false, assistantMessageId: "m1" });
  event("model.streaming", { kind: "text_delta", delta: "Hel", done: false, assistantMessageId: "m1" });
  event("model.streaming", { kind: "text_delta", delta: "lo", done: false, assistantMessageId: "m1" });
  setTimeout(completionTail, 20);
};

// An ask with both an allow and a deny option: the canonical permission card.
const permissionRequest = (id: string) =>
  send({
    id,
    method: "interaction/requestPermission",
    params: {
      toolCallId: "call_1",
      toolName: "Bash",
      riskLevel: "medium",
      reason: "run ls",
      input: { command: "ls", cwd: "/tmp" },
      options: [
        { optionId: "allow-1", kind: "allow", name: "Allow", response: { decision: "allow" } },
        { optionId: "deny-1", kind: "deny", name: "Deny", response: { decision: "deny" } },
      ],
    },
  });

// An ask whose only option denies: Full access must still fail closed into
// a card rather than echo a fabricated allow.
const denyOnlyPermissionRequest = (id: string) =>
  send({
    id,
    method: "interaction/requestPermission",
    params: {
      toolCallId: "call_1",
      toolName: "Bash",
      riskLevel: "high",
      reason: "rm -rf /",
      input: { command: "rm -rf /" },
      options: [
        { optionId: "deny-1", kind: "deny", name: "Deny", response: { decision: "deny" } },
      ],
    },
  });

const userInputRequest = (id: string) =>
  send({
    id,
    method: "interaction/requestUserInput",
    params: {
      requestId: "uq-1",
      prompt: "Pick one",
      inputType: "choice",
      choices: ["alpha", "beta"],
      toolCallId: "call_1",
      toolName: "ask_user",
    },
  });

let nextRequestId = 100;
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

    // An answer to one of our server→client interaction requests: record it
    // and play the completion tail once the ask is settled.
    if (msg.method === undefined && typeof msg.id === "string" && msg.id.startsWith("srv-")) {
      if (msg.result !== undefined || msg.error !== undefined) {
        dump.answers[msg.id] = msg.result ?? msg.error;
        writeDump();
        if (!msg.id.endsWith("-done")) {
          setTimeout(completionTail, 20);
        }
      }
      continue;
    }
    if (msg.method === undefined) continue;

    dump.calls.push({ id: msg.id, method: msg.method, params: msg.params });
    switch (msg.method) {
      case "session/create":
        reply(msg.id, sessionResult("sess_fake_1", msg.params?.mode, msg.params));
        break;
      case "session/resume":
        if (mode === "resume-refused") fail(msg.id, -32602, "no such session");
        else reply(msg.id, sessionResult("sess_fake_1", msg.params?.mode, msg.params));
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
      case "session/stop":
        reply(msg.id, {});
        break;
      case "session/send": {
        reply(msg.id, { accepted: true, inputId: "in-1" });
        if (mode === "exit-mid-turn") {
          process.stderr.write("synthetic mid-turn crash\n");
          process.exit(1);
          break;
        }
        if (mode === "approval") {
          setTimeout(() => permissionRequest(`srv-${nextRequestId++}`), 20);
        } else if (mode === "approval-no-allow") {
          setTimeout(() => denyOnlyPermissionRequest(`srv-${nextRequestId++}`), 20);
        } else if (mode === "question") {
          setTimeout(() => userInputRequest(`srv-${nextRequestId++}`), 20);
        } else {
          setTimeout(scriptedTurn, 20);
        }
        break;
      }
      default:
        fail(msg.id, -32601, `Unsupported server request: ${msg.method}`);
    }
    writeDump();
  }
});
