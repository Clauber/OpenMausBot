// The codex (ChatGPT subscription) engine, end to end: boots the real
// harness against a fake chatgpt.com backend and a fake OAuth token endpoint,
// with a ChatGPT sign-in (auth.json) whose access token is about to expire.
// The test plays the browser: it starts a call, pipes the V3 events the live
// probes captured up the relay, and reads the server's appends down —
// pinning the wiring the unit tests cannot see: the session is created with
// a *refreshed* token and the credential never reaches the client, the
// delegation becomes a user message "via call" on the bot's thread, the
// bot's answer comes back as a delegation.context.append on that delegation,
// and hanging up sends session.close down the relay — with no token anywhere
// in the log.
//
// POSIX-gated like the other CLI e2es (the fakes are shebang scripts).
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LiveCallState } from "../shared/wire.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const STALE_TOKEN = `stale.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url")}.sig`;
const FRESH_TOKEN = "fresh-access-token-e2e";
const ANSWER_SDP = "v=0\r\no=- fake 2 IN IP4 127.0.0.1\r\n";
const DELEGATION_ITEM = "item_e2edelegation1";
const INPUT_WORDS = [" Please", " ask", " my", " agent", " to", " calculate", " six", " times", " seven"];

interface CodexCall {
  headers: Record<string, string | undefined>;
  body: { sdp?: unknown; session?: Record<string, unknown> };
}
interface TokenRequest { body: Record<string, unknown>; }

const posixOnly = describe.skipIf(process.platform === "win32");

posixOnly("Codex live call e2e", () => {
  let child: ChildProcess;
  let home = "";
  let base = "";
  let output = "";
  let oauth: Server;
  let oauthPort = 0;
  let backend: Server;
  let backendPort = 0;
  let tokenRequests: TokenRequest[] = [];
  let calls: CodexCall[] = [];
  const authPath = () => join(home, ".codex", "auth.json");

  const serverOutput = () => output;
  const post = async (path: string, body: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-live-codex-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(authPath(), JSON.stringify({
      last_refresh: "2026-10-06T18:05:59.790697Z",
      tokens: {
        access_token: STALE_TOKEN,
        account_id: "acc_e2e",
        id_token: "id-token-e2e",
        refresh_token: "rt-e2e-original",
      },
    }));
    writeFileSync(join(home, ".openmausbot", "config.json"), JSON.stringify({
      instances: {
        claude: {
          driver: "claudeAgent",
          environment: { FAKE_CLAUDE_REPLIES: JSON.stringify(["Six times seven is 42."]) },
          config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" },
        },
      },
    }));

    tokenRequests = [];
    oauth = createServer((req, res) => {
      if (req.method !== "POST" || !(req.url ?? "").endsWith("/oauth/token")) { res.writeHead(404).end(); return; }
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        tokenRequests.push({ body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: FRESH_TOKEN, refresh_token: "rt-e2e-rotated" }));
      });
    });
    oauthPort = await new Promise((resolve) => { oauth.listen(0, "127.0.0.1", () => resolve((oauth.address() as { port: number }).port)); });

    calls = [];
    backend = createServer((req, res) => {
      if (req.method !== "POST" || !(req.url ?? "").includes("/realtime/calls")) { res.writeHead(404).end(); return; }
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        calls.push({ headers: { ...req.headers } as Record<string, string | undefined>, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") });
        res.writeHead(201, { "content-type": "application/sdp", location: "/backend-api/codex/realtime/calls/rtc_e2e_1" });
        res.end(ANSWER_SDP);
      });
    });
    backendPort = await new Promise((resolve) => { backend.listen(0, "127.0.0.1", () => resolve((backend.address() as { port: number }).port)); });

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
        OMB_CODEX_AUTH_FILE: authPath(),
        OMB_CODEX_LIVE_URL: `http://127.0.0.1:${backendPort}`,
        OMB_CODEX_OAUTH_URL: `http://127.0.0.1:${oauthPort}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk) => (output += chunk));
    child.stderr!.on("data", (chunk) => (output += chunk));
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
    oauth?.close();
    backend?.close();
    if (home) await removeTempDir(home);
  });

  /** The browser's side of a codex call: attach the relay, pipe the probe's
   * events up, and return the recorder for the server's appends. */
  const attachRelay = async (callId: string): Promise<SseRecorder> => {
    const relay = await openSse(`${base}/api/live/call/relay?callId=${encodeURIComponent(callId)}`);
    await post("/api/live/call/relay", {
      callId,
      events: [
        ...INPUT_WORDS.map((word, index) => JSON.stringify({
          type: "input_transcript.added",
          item: { id: `item_in${index}`, text: word, type: "input_transcript" },
          start_ms: 100 + index * 200,
          end_ms: 280 + index * 200,
        })),
        JSON.stringify({
          type: "delegation.created",
          offset_ms: 2_000,
          item: {
            type: "delegation", id: DELEGATION_ITEM, target: "client", handoff_id: "handoff_1",
            content: [{ type: "input_text", text: "Please ask my agent to calculate six times seven" }],
            user_bidi_turn_id: "turn_1",
          },
        }),
      ],
    });
    return relay;
  };

  it("runs a spoken request through the bot on the ChatGPT sign-in and speaks the answer back over the relay", async () => {
    const created = await post("/api/bots", {});
    const bot = (created.body as { bot: { id: string; threadId: string } }).bot;
    const patched = await fetch(`${base}/api/bots/${bot.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callEngine: "codex", modelSelection: { instanceId: "claude", model: "claude-fake" } }),
    });
    expect(patched.status).toBe(200);

    const sse = await openSse(`${base}/api/events`);
    try {
      const started = await post("/api/live/session", { botId: bot.id, sdp: "v=0\r\no=- offer 1 IN IP4 127.0.0.1\r\n", client: "desktop" });
      expect(started.status).toBe(201);
      const call = (started.body as { call: LiveCallState }).call;
      expect(call.engine).toBe("codex");
      // the answer SDP went back to the client; the credential did not
      expect(started.body.transport).toMatchObject({ type: "webrtc", sdp: ANSWER_SDP });
      expect(JSON.stringify(started.body)).not.toContain(FRESH_TOKEN);
      expect(JSON.stringify(started.body)).not.toContain("rt-e2e");

      // the session was created server-side, with a refreshed bearer token
      // and the exact shape the probes proved
      expect(calls).toHaveLength(1);
      expect(calls[0].headers.authorization).toBe(`Bearer ${FRESH_TOKEN}`);
      expect(calls[0].headers["chatgpt-account-id"]).toBe("acc_e2e");
      expect(calls[0].headers["openai-alpha"]).toBe("quicksilver=v2");
      expect(calls[0].body.session).toMatchObject({ model: "gpt-live-1-codex", delegation: { type: "client" }, audio: { output: { voice: "cove" } } });
      expect(tokenRequests).toEqual([{ body: { grant_type: "refresh_token", refresh_token: "rt-e2e-original", client_id: "app_EMoamEEZ73f0CkXaXp7hrann" } }]);
      // the refreshed grant went back into the sign-in file for the Codex CLI
      const authOnDisk = JSON.parse((await import("node:fs")).readFileSync(authPath(), "utf8")) as { tokens: Record<string, string> };
      expect(authOnDisk.tokens.access_token).toBe(FRESH_TOKEN);
      expect(authOnDisk.tokens.refresh_token).toBe("rt-e2e-rotated");
      expect(authOnDisk.tokens.account_id).toBe("acc_e2e");

      // the browser attaches the relay and the call goes live
      const relay = await attachRelay(call.callId);
      await sse.until((frame) => frame.kind === "live.call" && frame.call?.callId === call.callId && frame.call?.status === "live");

      // the delegation became a user message via call, on the bot's thread
      const asked = await sse.until(
        (frame) => frame.kind === "message" && frame.threadId === bot.threadId && frame.message?.role === "user" && frame.message?.via === "call",
        20_000,
      );
      expect(asked.message.text).toBe("Please ask my agent to calculate six times seven");

      // the bot's answer comes back as the delegation's spoken result
      const spoken = await relay.until(
        (frame) => frame.type === "delegation.context.append" && frame.delegation_item_id === DELEGATION_ITEM
          && JSON.stringify(frame.content).includes("42"),
        20_000,
      );
      expect(spoken.channel).toBe("speakable");
      expect(spoken.content).toEqual([{ type: "input_text", text: expect.stringContaining("42") }]);

      // hanging up sends session.close down the relay and ends the call
      const ended = await post("/api/live/call/end", { callId: call.callId });
      expect(ended.status).toBe(200);
      expect((ended.body as { call: LiveCallState }).call.status).toBe("ended");
      await expect(relay.until((frame) => frame.type === "session.close", 10_000)).resolves.toMatchObject({ type: "session.close" });
      await sse.until((frame) => frame.kind === "live.call" && frame.call?.callId === call.callId && frame.call?.status === "ended");
      await expect.poll(serverOutput, { timeout: 5_000 }).toMatch(/\[live\] call ended bot=\S+ .*end=hung-up/);
      expect(serverOutput()).toContain("text=(spoken)");
      expect(serverOutput()).not.toContain(FRESH_TOKEN);
      expect(serverOutput()).not.toContain("rt-e2e-original");
      expect(JSON.stringify(sse.frames)).not.toContain(FRESH_TOKEN);
      relay.close();
    } finally {
      sse.close();
    }
  }, 60_000);

  it("refuses a codex call from a phone (its app cannot pipe the relay yet) and 404s unknown relays", async () => {
    const created = await post("/api/bots", {});
    const bot = (created.body as { bot: { id: string } }).bot;
    await fetch(`${base}/api/bots/${bot.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callEngine: "codex" }),
    });
    const started = await post("/api/live/session", { botId: bot.id, sdp: "v=0\r\n", client: "ios" });
    expect(started.status).toBe(400);
    expect((started.body as { error: string }).error).toMatch(/desktop/i);
    // no session reached the backend for the refused call
    expect(calls).toHaveLength(1);

    const up = await post("/api/live/call/relay", { callId: "rtc_unknown", events: ["{}"] });
    expect(up.status).toBe(404);
  }, 30_000);
});
