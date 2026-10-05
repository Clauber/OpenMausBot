// Live call receipts and ask_compute, end to end: the real harness against the
// fake GPT-Live and the fake engines. A call leaves exactly one call_receipt
// in its thread (late transcript updates it in place), and the voice can hand
// real work to the bot's own engine with ask_compute, under the per-call cap,
// the delegation timeout and the thread's approval mode.
//
// POSIX-gated like the other CLI e2es (the fakes are shebang scripts).
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CallReceiptData } from "../shared/call-receipt.ts";
import type { LiveCallState } from "../shared/wire.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { startFakeOpenAiLive, type FakeOpenAiLive } from "./testing/fake-openai-live.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const LIVE_KEY = "sk-fake-e2e";
const SDP = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n";
const posixOnly = describe.skipIf(process.platform === "win32");

posixOnly("Live call receipts and ask_compute e2e", () => {
  let child: ChildProcess;
  let home = "";
  let base = "";
  let output = "";
  let live: FakeOpenAiLive;

  /** Everything the harness printed: stdout is where server.log comes from. */
  const serverOutput = () => output;
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const createBot = async (instanceId = "claude", model = "claude-fake"): Promise<{ id: string; threadId: string }> => {
    const { bot } = (await post("/api/bots", {})).body as { bot: { id: string; threadId: string } };
    const res = await fetch(`${base}/api/bots/${bot.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelSelection: { instanceId, model } }),
    });
    expect(res.status).toBe(200);
    return bot;
  };
  /** Starts a call and returns it with the fake's record of its session. */
  const startCall = async (botId: string, client: LiveCallState["client"] = "desktop") => {
    const before = live.sessions.length;
    const started = await post("/api/live/session", { botId, sdp: SDP, client });
    expect(started.status).toBe(201);
    const { call } = started.body as { call: LiveCallState };
    const session = live.sessions[before];
    expect(session).toBeDefined();
    return { started, call, session };
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    chmodSync(FAKE_ACP, 0o755);
    live = await startFakeOpenAiLive();
    home = mkdtempSync(join(tmpdir(), "omb-live-call-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    writeFileSync(
      join(home, ".openmausbot", "config.json"),
      JSON.stringify({
        instances: {
          claude: {
            driver: "claudeAgent",
            environment: { FAKE_CLAUDE_REPLIES: JSON.stringify(["Six times seven is 42."]) },
            config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" },
          },
          // cannot steer and never finishes: a request made while it works waits in the queue
          acp: { driver: "grokAgent", environment: { FAKE_ACP_MODE: "hang" }, config: { cli: FAKE_ACP, fullAuto: true } },
          // every turn asks permission to run a command
          asks: { driver: "grokAgent", environment: { FAKE_ACP_MODE: "permission" }, config: { cli: FAKE_ACP, fullAuto: false } },
          questions: { driver: "grokAgent", environment: { FAKE_ACP_MODE: "question" }, config: { cli: FAKE_ACP, fullAuto: false } },
        },
      }),
    );
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home,
        USERPROFILE: home,
        OMB_PORT: String(port),
        OMB_WEBHOOK_PORT: String(port + 1),
        OMB_OPENAI_LIVE_URL: live.url,
        OMB_OPENAI_LIVE_KEY: LIVE_KEY,
        // shortens the 90 s ask_compute budget so the timeout path runs in seconds
        OMB_ASK_COMPUTE_TIMEOUT_MS: "4000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk) => (output += chunk));
    child.stderr!.on("data", (chunk) => (output += chunk));
    // Generous: a loaded machine can take most of a minute to boot the harness.
    const deadline = Date.now() + 90_000;
    for (;;) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. output:\n${output}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. output:\n${output}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 120_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await live?.stop();
    if (home) await removeTempDir(home);
  });

  type Line = { id: string; role: string; kind: string; text?: string; via?: string; sendId?: string; turnTerminal?: boolean; callReceipt?: CallReceiptData; card?: { requestId?: string; tool?: string; answered?: string; answeredBy?: unknown } };
  const lines = async (threadId: string): Promise<Line[]> => ((await (await fetch(`${base}/api/threads/${threadId}/messages`)).json()) as { messages: Line[] }).messages;
  const receipts = async (threadId: string) => (await lines(threadId)).filter((m) => m.kind === "call_receipt");
  const interrupt = (bot: { id: string; threadId: string }) => post(`/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });

  it("(a) leaves exactly one receipt in the thread with the lines and the duration", async () => {
    const bot = await createBot();
    const { call, session } = await startCall(bot.id);
    await live.waitForAttach(session.id);
    live.emit(session.id, { type: "session.input_transcript.delta", delta: "hello ", start_ms: 100, end_ms: 400 });
    live.emit(session.id, { type: "session.input_transcript.delta", delta: "there", start_ms: 400, end_ms: 800 });
    live.emit(session.id, { type: "session.output_transcript.delta", delta: "Hi, how can I help?", start_ms: 2_500, end_ms: 4_000 });
    live.emit(session.id, { type: "session.input_transcript.delta", delta: "just testing", start_ms: 6_000, end_ms: 7_000 });
    // transcript is read in order; the end call round-trips through the same socket
    expect(await post("/api/live/call/end", { callId: call.callId })).toMatchObject({ status: 200, body: { call: { status: "ended" } } });

    const found = await receipts(bot.threadId);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ role: "bot", kind: "call_receipt" });
    expect(found[0].callReceipt).toMatchObject({
      callId: call.callId, botId: bot.id, threadId: bot.threadId, durationSec: 42, outcome: "completed", endReason: "hung-up",
      lines: [{ side: "you", text: "hello there" }, { side: "bot", text: "Hi, how can I help?" }, { side: "you", text: "just testing" }],
    });
    expect(found[0].text).toContain("You: hello there");
    // durable on disk too, owner-only
    const file = join(home, ".openmausbot", "call-receipts", `${call.callId}.json`);
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ callId: call.callId, lines: [{ text: "hello there" }, { text: "Hi, how can I help?" }, { text: "just testing" }] });
    expect(serverOutput()).not.toMatch(/hello there|just testing/);
  }, 40_000);

  it("(b) a transcript that arrives after the end updates the receipt instead of adding another", async () => {
    live.setCloseLinger(2_000);
    try {
      const bot = await createBot();
      const { call, session } = await startCall(bot.id);
      await live.waitForAttach(session.id);
      live.emit(session.id, { type: "session.input_transcript.delta", delta: "remind me tomorrow", start_ms: 100, end_ms: 900 });
      expect(await post("/api/live/call/end", { callId: call.callId })).toMatchObject({ status: 200 });
      expect((await receipts(bot.threadId))[0].callReceipt?.lines).toEqual([{ side: "you", text: "remind me tomorrow" }]);

      // the sideband is still up for a moment: the trailing words land on the same receipt
      live.emit(session.id, { type: "session.output_transcript.delta", delta: "Sure, noted.", start_ms: 1_000, end_ms: 1_800 });
      await expect.poll(async () => (await receipts(bot.threadId))[0]?.callReceipt?.lines, { timeout: 5_000 })
        .toEqual([{ side: "you", text: "remind me tomorrow" }, { side: "bot", text: "Sure, noted." }]);
      const after = await receipts(bot.threadId);
      expect(after).toHaveLength(1);
      expect(after[0].text).toContain("Bot: Sure, noted.");
      expect(JSON.parse(readFileSync(join(home, ".openmausbot", "call-receipts", `${call.callId}.json`), "utf8")).lines).toHaveLength(2);
    } finally {
      live.setCloseLinger(0);
    }
  }, 40_000);

  it("(c) ask_compute runs a visible turn on the thread and returns its answer to the call", async () => {
    const bot = await createBot();
    const { call, session } = await startCall(bot.id);
    await live.waitForAttach(session.id);
    // the voice is offered the tool, and nothing else new on the data channel
    expect(session.body).toMatchObject({ session: { tools: [{ type: "function", name: "ask_compute" }] } });

    const id = live.callTool(session.id, "ask_compute", { request: "what is six times seven" });
    const result = (await live.waitForToolOutput(session.id, id)) as { ok: boolean; answer?: string };
    expect(result).toMatchObject({ ok: true });
    expect(result.answer).toContain("42");

    const thread = await lines(bot.threadId);
    const asked = thread.find((m) => m.role === "user" && m.text === "what is six times seven");
    expect(asked).toMatchObject({ via: "call" });
    expect(asked?.sendId).toMatch(/^ask_compute-/);
    expect(thread.some((m) => m.role === "bot" && m.kind === "text" && m.turnTerminal && m.text?.includes("42"))).toBe(true);
    // the answer rides the tool output; it is not also read out as commentary
    expect(session.commands.filter((c) => c.type === "session.commentary.append")).toHaveLength(0);

    expect(await post("/api/live/call/end", { callId: call.callId })).toMatchObject({ status: 200 });
    const [receipt] = await receipts(bot.threadId);
    expect(receipt.callReceipt?.compute).toEqual([{ request: "what is six times seven", ok: true }]);
  }, 60_000);

  it("(d) refuses a seventh ask_compute, and times out one that never finishes", async () => {
    const bot = await createBot();
    const { call, session } = await startCall(bot.id);
    await live.waitForAttach(session.id);
    for (let n = 1; n <= 6; n += 1) {
      const id = live.callTool(session.id, "ask_compute", { request: `question ${n}` });
      expect(await live.waitForToolOutput(session.id, id), `ask ${n}`).toMatchObject({ ok: true });
    }
    const before = (await lines(bot.threadId)).filter((m) => m.via === "call").length;
    expect(before).toBe(6);
    const seventh = live.callTool(session.id, "ask_compute", { request: "question 7" });
    expect(await live.waitForToolOutput(session.id, seventh)).toMatchObject({ ok: false, error: expect.stringContaining("limited to 6") });
    // refused: nothing reached the engine
    expect((await lines(bot.threadId)).filter((m) => m.via === "call")).toHaveLength(6);
    expect(await post("/api/live/call/end", { callId: call.callId })).toMatchObject({ status: 200 });

    // a turn that never finishes hits the delegation timeout (4 s here, 90 s by default)
    const slow = await createBot("acp", "fake-model");
    const second = await startCall(slow.id);
    await live.waitForAttach(second.session.id);
    const started = Date.now();
    const hang = live.callTool(second.session.id, "ask_compute", { request: "do the long thing" });
    const timedOut = await live.waitForToolOutput(second.session.id, hang, 30_000);
    expect(timedOut).toMatchObject({ ok: false, error: expect.stringContaining("did not finish within 4 seconds") });
    expect(Date.now() - started).toBeGreaterThanOrEqual(3_500);
    await interrupt(slow);
    expect(await post("/api/live/call/end", { callId: second.call.callId })).toMatchObject({ status: 200 });
  }, 120_000);

  it("(e) a call in Ask mode raises the normal approval card before the compute turn runs", async () => {
    const bot = await createBot("asks", "fake-model");
    const { call, session } = await startCall(bot.id);
    try {
      await live.waitForAttach(session.id);
      const id = live.callTool(session.id, "ask_compute", { request: "run the check" });
      // the card is on the thread; the engine has not run its command and the tool has not answered
      let card: Line | undefined;
      await expect.poll(async () => (card = (await lines(bot.threadId)).find((m) => m.kind === "options" && m.card?.requestId && m.card.tool)), { timeout: 20_000 }).toBeDefined();
      expect(card?.card?.answered).toBeUndefined();
      await live.waitForCommand(session.id, (c) => c.type === "session.instructions.append" && String(c.content).includes("May I?"), 20_000);
      expect(session.commands.some((c) => c.type === "session.tool_call.output")).toBe(false);
      expect((await lines(bot.threadId)).some((m) => m.role === "bot" && m.kind === "text" && m.turnTerminal)).toBe(false);

      // the person approves by voice, as on any call; only then does the turn finish
      live.emit(session.id, { type: "session.input_transcript.delta", delta: "yes", start_ms: 5_000, end_ms: 5_300 });
      live.emit(session.id, { type: "session.delegation.created", offset_ms: 5_400, delegation: { id: "del_yes", target: "client" } });
      const result = await live.waitForToolOutput(session.id, id, 30_000);
      expect(result).toMatchObject({ ok: true });
      expect(String(result.answer)).toContain("handled the permission decision");
      const decided = (await lines(bot.threadId)).find((m) => m.card?.requestId === card?.card?.requestId);
      expect(decided?.card).toMatchObject({ answered: "allow", answeredBy: { via: "call" } });
    } finally {
      await interrupt(bot);
      await post("/api/live/call/end", { callId: call.callId });
    }
  }, 90_000);

  it("(f) the per-bot switch removes ask_compute", async () => {
    const bot = await createBot();
    const patched = await fetch(`${base}/api/bots/${bot.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ liveCompute: false }) });
    expect(patched.status).toBe(200);
    const { call, session } = await startCall(bot.id);
    await live.waitForAttach(session.id);
    expect((session.body.session as Record<string, unknown>).tools).toBeUndefined();
    const id = live.callTool(session.id, "ask_compute", { request: "anything" });
    expect(await live.waitForToolOutput(session.id, id)).toMatchObject({ ok: false, error: expect.stringContaining("turned off") });
    expect((await lines(bot.threadId)).some((m) => m.via === "call")).toBe(false);
    expect(await post("/api/live/call/end", { callId: call.callId })).toMatchObject({ status: 200 });
  }, 40_000);
});
