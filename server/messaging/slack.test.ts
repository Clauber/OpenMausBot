import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startFakeSlack, type FakeSlack } from "../testing/fake-slack.ts";
import { SlackBindingStore } from "./slack-store.ts";
import { SlackService, type SlackHost, type SlackPhase } from "./slack-service.ts";
import { createSlackClient, SlackApiError, slackApiBase } from "./slack.ts";

const BOT_TOKEN = "xoxb-fake-000000000000-111111111111-Zzzautomatttoken";
const APP_TOKEN = "xapp-1-F00000000000-999999999999-Aaaautomatttoken";
let fake: FakeSlack;
let dir: string;

beforeEach(async () => {
  fake = await startFakeSlack();
  dir = mkdtempSync(join(tmpdir(), "omb-slack-"));
});
afterEach(async () => {
  await fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("slack client", () => {
  it("defaults to the real API base and honours SLACK_API_BASE", () => {
    expect(slackApiBase({})).toBe("https://slack.com/api");
    expect(slackApiBase({ SLACK_API_BASE: "http://127.0.0.1:9/" })).toBe("http://127.0.0.1:9");
  });

  it("speaks auth.test, chat.postMessage and apps.connections.open", async () => {
    const client = createSlackClient({ apiBase: fake.url });
    const me = await client.authTest(BOT_TOKEN);
    expect(me).toMatchObject({ team_id: "T0FAKE01TEAM", user_id: "U0FAKEBOTUSER", bot_id: "B0FAKEBOTID0" });
    expect(fake.authTestCalls[0]).toMatchObject({ token: BOT_TOKEN });
    expect((await client.postMessage(BOT_TOKEN, "D01", "hello")).ts).toMatch(/^\d+\.\d+$/);
    expect(fake.sent).toEqual([{ token: BOT_TOKEN, channel: "D01", text: "hello", at: expect.any(Number) }]);
    expect(await client.connectionsOpen(APP_TOKEN)).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/link\?ticket=/);
    expect(fake.connectionsOpenCalls[0]).toMatchObject({ token: APP_TOKEN });
  });

  it("surfaces Slack's error code and never the token", async () => {
    const bad = createSlackClient({ apiBase: fake.url });
    const auth = await bad.authTest("xoxb-wrong").catch((e) => e);
    expect(auth).toBeInstanceOf(SlackApiError);
    expect(auth.status).toBe(200);
    expect(auth.code).toBe("invalid_auth");
    const socket = await bad.connectionsOpen("xoxb-not-an-app-token").catch((e) => e);
    expect(socket).toBeInstanceOf(SlackApiError);
    expect(socket.code).toBe("not_allowed_token_type");
    const dead = createSlackClient({ apiBase: "http://127.0.0.1:1" });
    expect(String(await dead.authTest(BOT_TOKEN).catch((e) => e.message))).not.toContain(BOT_TOKEN);
  });
});

describe("slack binding store", () => {
  it("persists and reloads both tokens with private POSIX permissions", () => {
    const store = new SlackBindingStore(dir);
    const binding = store.create({ botId: "bot1", appToken: APP_TOKEN, botToken: BOT_TOKEN, teamId: "T0FAKE01TEAM", botUserId: "U0FAKEBOTUSER" });
    store.bindChat(binding.id, "D01", { threadId: "thr", name: "@U061", userId: "slack:U061" });
    if (process.platform !== "win32") expect(statSync(join(dir, "messaging", "slack.json")).mode & 0o777).toBe(0o600);
    const reloaded = new SlackBindingStore(dir).get(binding.id)!;
    expect(reloaded).toMatchObject({
      botId: "bot1", appToken: APP_TOKEN, botToken: BOT_TOKEN, teamId: "T0FAKE01TEAM", botUserId: "U0FAKEBOTUSER",
      chats: { D01: { threadId: "thr", enabled: true, userId: "slack:U061" } },
    });
  });

  it("pairing codes are 6 digits, single use, expiring, and burn after repeated misses", () => {
    let now = 1_000_000;
    const store = new SlackBindingStore(dir, () => now);
    const { id } = store.create({ botId: "b", appToken: APP_TOKEN, botToken: BOT_TOKEN });
    const { code } = store.startPairing(id)!;
    expect(code).toMatch(/^\d{6}$/);
    expect(store.tryPairingCode(id, code)).toBe(true);
    expect(store.tryPairingCode(id, code)).toBe(false);
    const second = store.startPairing(id)!.code;
    now += 11 * 60_000;
    expect(store.tryPairingCode(id, second)).toBe(false);
    const third = store.startPairing(id)!.code;
    const wrong = third === "000000" ? "000001" : "000000";
    for (let i = 0; i < 10; i += 1) expect(store.tryPairingCode(id, wrong)).toBe(false);
    expect(store.tryPairingCode(id, third)).toBe(false);
  });
});

describe("slack service (Socket Mode)", () => {
  let store: SlackBindingStore;
  let service: SlackService;
  let started: Array<{ threadId: string; text: string; sendId: string; senderName: string }>;
  let phases: SlackPhase[];
  let bindingId: string;
  let threads = 0;

  const host: SlackHost = {
    botName: () => "Pepper",
    createThread: () => `thread-${++threads}`,
    threadExists: () => true,
    startTurn: async (input) => { started.push(input); return { ok: true }; },
    readRequest: (_bot, _thread, sendId) => {
      const phase = phases.shift() ?? "settled";
      const text = started.find((s) => s.sendId === sendId)!.text;
      return { phase, ...(phase === "settled" ? { reply: `echo: ${text}` } : {}) };
    },
  };

  const waitConnected = async () => {
    for (let i = 0; i < 100 && service.socketState(bindingId)?.status !== "connected"; i += 1) await new Promise((r) => setTimeout(r, 20));
    return service.socketState(bindingId);
  };

  beforeEach(() => {
    started = []; phases = []; threads = 0;
    store = new SlackBindingStore(dir);
    const binding = store.create({ botId: "bot1", appToken: APP_TOKEN, botToken: BOT_TOKEN, botUserId: "U0FAKEBOTUSER" });
    bindingId = binding.id;
    service = new SlackService({
      store, host, pollMs: 5, maxWaitMs: 5_000, reconnectMs: 20,
      clientFor: () => createSlackClient({ apiBase: fake.url }),
    });
  });

  afterEach(() => { service.stop(); });

  it("connects over Socket Mode, acks envelopes, pairs a DM by code, then relays turns", async () => {
    service.startSocket(bindingId);
    expect(await waitConnected()).toMatchObject({ status: "connected" });
    expect(fake.connectionsOpenCalls).toHaveLength(1);

    // unknown conversation, no code: a hint, nothing more
    fake.pushDm({ channel: "D077", user: "U061", text: "hello?" });
    expect((await fake.waitForSent("D077"))[0]!.text).toMatch(/isn't paired/);
    expect(started).toEqual([]);

    // pairing: the code arrives as a DM from the owner's chat
    const { code } = store.startPairing(bindingId)!;
    fake.pushDm({ channel: "D077", user: "U061", text: "wrong first" });
    expect((await fake.waitForSent("D077", 2))[1]!.text).toMatch(/didn't match/);
    fake.pushDm({ channel: "D077", user: "U061", text: code });
    expect((await fake.waitForSent("D077", 3))[2]!.text).toBe("Paired with Pepper. Send a message to start.");
    expect(store.get(bindingId)!.chats.D077).toMatchObject({ threadId: "thread-1", enabled: true, userId: "slack:U061" });

    // a paired DM's message reaches the bot and its reply comes back
    phases = ["working", "settled"];
    fake.pushDm({ channel: "D077", user: "U061", text: "What is 2+2?" });
    expect((await fake.waitForSent("D077", 4))[3]!.text).toBe("echo: What is 2+2?");
    expect(started[0]).toMatchObject({ threadId: "thread-1", text: "What is 2+2?", senderName: "@U061" });
    expect(started[0]!.sendId).toMatch(/^sl-[A-Za-z0-9]{12}-\d+-\d+$/);

    // Slack got an ack for every envelope it delivered
    expect(fake.acks.length).toBeGreaterThanOrEqual(4);
    await service.idle();
  });

  it("ignores the bot's own echoes, other event types, edits, and muted conversations", async () => {
    service.startSocket(bindingId);
    await waitConnected();
    store.bindChat(bindingId, "D01", { threadId: "t" });
    store.setChatEnabled(bindingId, "D01", false);
    fake.pushDm({ channel: "D01", user: "U061", text: "muted" });
    fake.pushDm({ channel: "D01", user: "U0FAKEBOTUSER", text: "my own echo" });
    fake.pushEnvelope("events_api", { type: "event_callback", team_id: "T", event: { type: "message", channel_type: "im", channel: "D01", user: "U061", text: "edited", ts: "1.2", subtype: "message_changed" } });
    fake.pushEnvelope("interactive", { user: { id: "U061" } });
    await service.idle();
    await new Promise((r) => setTimeout(r, 100));
    expect(started).toEqual([]);
    expect(fake.sent).toEqual([]);
  });

  it("uses a deterministic sendId, so a redelivered envelope cannot start the turn twice", async () => {
    service.startSocket(bindingId);
    await waitConnected();
    store.bindChat(bindingId, "D01", { threadId: "t" });
    phases = ["settled", "settled"];
    fake.pushDm({ channel: "D01", user: "U061", text: "once", ts: "1700000000.000100" });
    await fake.waitForSent("D01");
    await service.idle();
    expect(started).toHaveLength(1);
    // Slack retries un-acked envelopes; same ts → same sendId
    fake.pushDm({ channel: "D01", user: "U061", text: "once", ts: "1700000000.000100" });
    await fake.waitForSent("D01", 2);
    await service.idle();
    expect(started).toHaveLength(2);
    expect(started[0]!.sendId).toBe(started[1]!.sendId);
  });

  it("tells the conversation when the bot is waiting for approval, then still delivers", async () => {
    service.startSocket(bindingId);
    await waitConnected();
    store.bindChat(bindingId, "D01", { threadId: "t" });
    phases = ["waiting", "waiting", "settled"];
    fake.pushDm({ channel: "D01", user: "U061", text: "do the thing" });
    const messages = await fake.waitForSent("D01", 2);
    expect(messages[0]!.text).toMatch(/needs your approval/);
    expect(messages[1]!.text).toBe("echo: do the thing");
  });

  it("surfaces a refused send to the conversation instead of staying silent", async () => {
    const refusing = new SlackService({
      store, pollMs: 5, maxWaitMs: 5_000, reconnectMs: 20,
      host: { ...host, startTurn: async () => ({ ok: false, error: "Couldn't reach the bot: busy" }) },
      clientFor: () => createSlackClient({ apiBase: fake.url }),
    });
    // the refusing service owns the binding's socket for this test
    service.stopSocket(bindingId);
    refusing.startSocket(bindingId);
    for (let i = 0; i < 100 && refusing.socketState(bindingId)?.status !== "connected"; i += 1) await new Promise((r) => setTimeout(r, 20));
    store.bindChat(bindingId, "D01", { threadId: "t" });
    fake.pushDm({ channel: "D01", user: "U061", text: "hi" });
    expect((await fake.waitForSent("D01"))[0]!.text).toBe("Couldn't reach the bot: busy");
    refusing.stop();
  });

  it("surfaces a token or Socket Mode config refusal as an error state and recovers on demand", async () => {
    fake.refuseConnectionsOpen();
    service.startSocket(bindingId);
    for (let i = 0; i < 100 && service.socketState(bindingId)?.status !== "error"; i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(service.socketState(bindingId)).toMatchObject({ status: "error" });
    expect(String(service.socketState(bindingId)!.error)).toMatch(/not_allowed_token_type/);
    // the operator fixes the app config; a restart connects again
    fake.allowConnectionsOpen();
    service.stopSocket(bindingId);
    service.startSocket(bindingId);
    expect(await waitConnected()).toMatchObject({ status: "connected" });
  });

  it("reconnects after a refresh_requested disconnect, and dies on link_disabled", async () => {
    service.startSocket(bindingId);
    expect(await waitConnected()).toMatchObject({ status: "connected" });
    const opens = fake.connectionsOpenCalls.length;
    fake.disconnectAll("refresh_requested");
    for (let i = 0; i < 100 && fake.connectionsOpenCalls.length <= opens; i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(await waitConnected()).toMatchObject({ status: "connected" });

    fake.disconnectAll("link_disabled");
    for (let i = 0; i < 100 && service.socketState(bindingId)?.status !== "error"; i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(service.socketState(bindingId)).toMatchObject({ status: "error" });
    expect(String(service.socketState(bindingId)!.error)).toMatch(/link_disabled/);
  });
});
