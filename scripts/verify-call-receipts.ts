// Live call receipts and ask_compute against an isolated fixture: the real
// harness, the fake GPT-Live and the fake engine. Never targets user data.
//   node --experimental-strip-types scripts/verify-call-receipts.ts
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { launchVerificationServer } from "./control-omb.ts";
import { startFakeOpenAiLive } from "../server/testing/fake-openai-live.ts";

const SDP = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n";

export async function verifyCallReceipts() {
  const live = await startFakeOpenAiLive();
  const fixture = await launchVerificationServer({
    FAKE_CLAUDE_REPLIES: JSON.stringify(["Six times seven is 42."]),
    OMB_OPENAI_LIVE_URL: live.url,
    OMB_OPENAI_LIVE_KEY: "sk-fake-verify",
  });
  const evidence: unknown[] = [];
  const evidencePath = `${fixture.info.logPath}.call-receipts.json`;
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(fixture.info.url + path, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    evidence.push({ method, path, body, status: response.status, result });
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result)}`);
    return result;
  };
  const thread = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages`)).messages as any[];
  const startCall = async (botId: string) => {
    const before = live.sessions.length;
    const { call } = await api("POST", "/api/live/session", { botId, sdp: SDP, client: "desktop" }, 201);
    const session = live.sessions[before]!;
    await live.waitForAttach(session.id);
    return { call, session };
  };
  try {
    const bot = (await api("GET", "/api/bots")).bots[0] as { id: string; threadId: string };
    await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "claude", model: "claude-fake" } });

    // (a) + (c): a call with ask_compute, then its receipt
    const first = await startCall(bot.id);
    live.emit(first.session.id, { type: "session.input_transcript.delta", delta: "can you check something", start_ms: 100, end_ms: 900 });
    live.emit(first.session.id, { type: "session.output_transcript.delta", delta: "Sure, one moment.", start_ms: 1_500, end_ms: 2_500 });
    const id = live.callTool(first.session.id, "ask_compute", { request: "what is six times seven" });
    const answer = await live.waitForToolOutput(first.session.id, id) as any;
    assert.equal(answer.ok, true);
    assert.match(answer.answer, /42/);
    assert((await thread(bot.threadId)).some((m) => m.role === "user" && m.via === "call" && m.text === "what is six times seven"), "compute turn is visible on the thread");
    await api("POST", "/api/live/call/end", { callId: first.call.callId });
    const receipts = (await thread(bot.threadId)).filter((m) => m.kind === "call_receipt");
    assert.equal(receipts.length, 1, "exactly one receipt");
    assert.equal(receipts[0].callReceipt.lines.length, 2);
    assert.equal(receipts[0].callReceipt.compute.length, 1);

    // (b): trailing transcript updates the same receipt
    live.setCloseLinger(2_000);
    const second = await startCall(bot.id);
    live.emit(second.session.id, { type: "session.input_transcript.delta", delta: "thanks", start_ms: 100, end_ms: 500 });
    await api("POST", "/api/live/call/end", { callId: second.call.callId });
    live.emit(second.session.id, { type: "session.output_transcript.delta", delta: "Any time.", start_ms: 900, end_ms: 1_400 });
    const deadline = Date.now() + 5_000;
    let late: any;
    while (Date.now() < deadline) {
      late = (await thread(bot.threadId)).filter((m) => m.kind === "call_receipt" && m.callReceipt.callId === second.call.callId);
      if (late[0]?.callReceipt.lines.length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(late.length, 1, "late transcript did not duplicate the receipt");
    assert.equal(late[0].callReceipt.lines.length, 2);
    live.setCloseLinger(0);

    // (d): the cap
    const third = await startCall(bot.id);
    for (let n = 1; n <= 6; n += 1) {
      const out = await live.waitForToolOutput(third.session.id, live.callTool(third.session.id, "ask_compute", { request: `q${n}` })) as any;
      assert.equal(out.ok, true, `ask ${n}`);
    }
    const seventh = await live.waitForToolOutput(third.session.id, live.callTool(third.session.id, "ask_compute", { request: "q7" })) as any;
    assert.equal(seventh.ok, false);
    assert.match(seventh.error, /limited to 6/);
    await api("POST", "/api/live/call/end", { callId: third.call.callId });
    evidence.push({ ok: true, receipts: (await thread(bot.threadId)).filter((m) => m.kind === "call_receipt").length });
    return { ok: true, evidencePath, logPath: fixture.info.logPath };
  } finally {
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    await fixture.close();
    await live.stop();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  verifyCallReceipts().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`), (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
