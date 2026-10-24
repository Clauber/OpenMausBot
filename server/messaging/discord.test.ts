import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FAKE_BOT_TOKEN, FAKE_BOT_USER_ID, startFakeDiscord, type FakeDiscord } from "../testing/fake-discord.ts";
import { DiscordBindingStore } from "./discord-store.ts";
import { DiscordService, type DiscordHost, type DiscordPhase } from "./discord-service.ts";
import { createDiscordClient, DiscordApiError, discordApiBase, splitDiscordText } from "./discord.ts";

const TOKEN = FAKE_BOT_TOKEN;
let fake: FakeDiscord;
let dir: string;

beforeEach(async () => {
  fake = await startFakeDiscord({ heartbeatMs: 200 });
  dir = mkdtempSync(join(tmpdir(), "omb-discord-"));
});
afterEach(async () => {
  await fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("discord client", () => {
  it("defaults to the real API base and honours DISCORD_API_BASE", () => {
    expect(discordApiBase({})).toBe("https://discord.com/api/v10");
    expect(discordApiBase({ DISCORD_API_BASE: "http://127.0.0.1:9/" })).toBe("http://127.0.0.1:9");
  });

  it("speaks users/@me, gateway/bot, message sends and typing", async () => {
    const client = createDiscordClient({ apiBase: fake.url });
    expect(await client.usersMe(TOKEN)).toMatchObject({ id: FAKE_BOT_USER_ID, bot: true });
    expect(fake.usersMeCalls[0]).toMatchObject({ token: TOKEN });
    const gateway = await client.getGatewayBot(TOKEN);
    expect(gateway.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/gateway/);
    expect(gateway.session_start_limit).toMatchObject({ max_concurrency: 1 });
    expect((await client.createMessage(TOKEN, "999", "hello")).id).toMatch(/^\d{19}$/);
    expect(fake.sent).toEqual([{ token: TOKEN, channel_id: "999", content: "hello", at: expect.any(Number) }]);
    await client.triggerTyping(TOKEN, "999");
    expect(fake.typingCalls).toEqual([{ token: TOKEN, channel_id: "999", at: expect.any(Number) }]);
  });

  it("splits long replies at 2000 characters, in order, losing nothing", async () => {
    const client = createDiscordClient({ apiBase: fake.url });
    const text = Array.from({ length: 1200 }, (_, i) => `word${i}`).join(" ");
    expect(text.length).toBeGreaterThan(2000);
    const count = await client.sendText(TOKEN, "5", text);
    const sent = fake.sent.map((m) => m.content);
    expect(count).toBe(sent.length);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent.every((part) => part.length <= 2000)).toBe(true);
    expect(sent.join(" ")).toBe(text);
    expect(splitDiscordText("x".repeat(4500)).map((p) => p.length)).toEqual([2000, 2000, 500]);
  });

  it("does not put the token in surfaced errors", async () => {
    const bad = createDiscordClient({ apiBase: fake.url });
    const error = await bad.usersMe("MWrongToken-wrongtoken-wrongtoken-wrongtoken").catch((e) => e);
    expect(error).toBeInstanceOf(DiscordApiError);
    expect(error.status).toBe(401);
    const dead = createDiscordClient({ apiBase: "http://127.0.0.1:1" });
    expect(String(await dead.usersMe(TOKEN).catch((e) => e.message))).not.toContain(TOKEN);
  });
});

describe("discord binding store", () => {
  it("persists and reloads the token with private POSIX permissions", () => {
    const store = new DiscordBindingStore(dir);
    const binding = store.create({ botId: "bot1", token: TOKEN, userId: FAKE_BOT_USER_ID, username: "fake_omb_bot" });
    store.bindChat(binding.id, "888", { threadId: "thr", name: "@clauber", userId: "discord:900000000000000002" });
    if (process.platform !== "win32") expect(statSync(join(dir, "messaging", "discord.json")).mode & 0o777).toBe(0o600);
    const reloaded = new DiscordBindingStore(dir).get(binding.id)!;
    expect(reloaded).toMatchObject({
      botId: "bot1", token: TOKEN, userId: FAKE_BOT_USER_ID, username: "fake_omb_bot",
      chats: { "888": { threadId: "thr", enabled: true, userId: "discord:900000000000000002" } },
    });
    expect(binding.id).toMatch(/^dc_[A-Za-z0-9_-]+$/);
  });

  it("pairing codes are 6 digits, single use, expiring, and burn after repeated misses", () => {
    let now = 1_000_000;
    const store = new DiscordBindingStore(dir, () => now);
    const { id } = store.create({ botId: "b", token: TOKEN });
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

describe("discord service (gateway)", () => {
  let store: DiscordBindingStore;
  let service: DiscordService;
  let started: Array<{ threadId: string; text: string; sendId: string; senderName: string }>;
  let phases: DiscordPhase[];
  let bindingId: string;
  let threads = 0;

  const host: DiscordHost = {
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
    store = new DiscordBindingStore(dir);
    const binding = store.create({ botId: "bot1", token: TOKEN, userId: FAKE_BOT_USER_ID });
    bindingId = binding.id;
    service = new DiscordService({
      store, host, pollMs: 5, maxWaitMs: 5_000, reconnectMs: 20, maxHeartbeatMs: 400,
      clientFor: () => createDiscordClient({ apiBase: fake.url }),
    });
  });

  afterEach(() => { service.stop(); });

  it("identifies over the gateway, heartbeats, pairs a DM by code, then relays turns", async () => {
    service.startSocket(bindingId);
    expect(await waitConnected()).toMatchObject({ status: "connected" });
    expect(fake.identifies).toBe(1);
    // the binding's identity is confirmed from READY
    expect(store.get(bindingId)!.userId).toBe(FAKE_BOT_USER_ID);
    await new Promise((r) => setTimeout(r, 700));
    expect(fake.heartbeats).toBeGreaterThanOrEqual(2);

    // unknown conversation, no code: a hint, nothing more
    fake.pushDm({ channel: "777", content: "hello?" });
    expect((await fake.waitForSent("777"))[0]!.content).toMatch(/isn't paired/);
    expect(started).toEqual([]);

    // pairing: the code arrives as a DM from the owner's chat
    const { code } = store.startPairing(bindingId)!;
    fake.pushDm({ channel: "777", content: "wrong first" });
    expect((await fake.waitForSent("777", 2))[1]!.content).toMatch(/didn't match/);
    fake.pushDm({ channel: "777", content: code });
    expect((await fake.waitForSent("777", 3))[2]!.content).toBe("Paired with Pepper. Send a message to start.");
    expect(store.get(bindingId)!.chats["777"]).toMatchObject({ threadId: "thread-1", enabled: true, userId: "discord:900000000000000002" });

    // a paired DM's message reaches the bot and its reply comes back (split-safe)
    phases = ["working", "settled"];
    fake.pushDm({ channel: "777", content: "What is 2+2?" });
    expect((await fake.waitForSent("777", 4))[3]!.content).toBe("echo: What is 2+2?");
    expect(started[0]).toMatchObject({ threadId: "thread-1", text: "What is 2+2?", senderName: "@clauber" });
    expect(started[0]!.sendId).toMatch(/^dc-[A-Za-z0-9]{12}-\d{19}$/);
    await service.idle();
  });

  it("ignores guild messages, its own echoes, and muted conversations", async () => {
    service.startSocket(bindingId);
    await waitConnected();
    store.bindChat(bindingId, "800", { threadId: "t" });
    store.setChatEnabled(bindingId, "800", false);
    fake.pushDm({ channel: "800", content: "muted" });
    fake.pushDm({ channel: "801", content: "not my own echo", user: FAKE_BOT_USER_ID });
    fake.pushDm({ channel: "802", content: "guild message", guildId: "700000000000000007" });
    await service.idle();
    await new Promise((r) => setTimeout(r, 150));
    expect(started).toEqual([]);
    expect(fake.sent).toEqual([]);
  });

  it("uses a deterministic sendId, so a redelivered message cannot start the turn twice", async () => {
    service.startSocket(bindingId);
    await waitConnected();
    store.bindChat(bindingId, "805", { threadId: "t" });
    phases = ["settled", "settled"];
    fake.pushDm({ channel: "805", content: "once", id: "1234567890123456789" });
    await fake.waitForSent("805");
    await service.idle();
    expect(started).toHaveLength(1);
    fake.pushDm({ channel: "805", content: "once", id: "1234567890123456789" });
    await fake.waitForSent("805", 2);
    await service.idle();
    expect(started).toHaveLength(2);
    expect(started[0]!.sendId).toBe(started[1]!.sendId);
  });

  it("tells the conversation when the bot is waiting for approval, then still delivers", async () => {
    service.startSocket(bindingId);
    await waitConnected();
    store.bindChat(bindingId, "810", { threadId: "t" });
    phases = ["waiting", "waiting", "settled"];
    fake.pushDm({ channel: "810", content: "do the thing" });
    const messages = await fake.waitForSent("810", 2);
    expect(messages[0]!.content).toMatch(/needs your approval/);
    expect(messages[1]!.content).toBe("echo: do the thing");
  });

  it("surfaces a refused send to the conversation instead of staying silent", async () => {
    service.stopSocket(bindingId);
    const refusing = new DiscordService({
      store, pollMs: 5, maxWaitMs: 5_000, reconnectMs: 20, maxHeartbeatMs: 400,
      host: { ...host, startTurn: async () => ({ ok: false, error: "Couldn't reach the bot: busy" }) },
      clientFor: () => createDiscordClient({ apiBase: fake.url }),
    });
    refusing.startSocket(bindingId);
    for (let i = 0; i < 100 && refusing.socketState(bindingId)?.status !== "connected"; i += 1) await new Promise((r) => setTimeout(r, 20));
    store.bindChat(bindingId, "815", { threadId: "t" });
    fake.pushDm({ channel: "815", content: "hi" });
    expect((await fake.waitForSent("815"))[0]!.content).toBe("Couldn't reach the bot: busy");
    refusing.stop();
  });

  it("surfaces a dead token as an error state, and recovers on demand", async () => {
    fake.refuseAuth();
    service.startSocket(bindingId);
    for (let i = 0; i < 100 && service.socketState(bindingId)?.status !== "error"; i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(service.socketState(bindingId)).toMatchObject({ status: "error" });
    expect(String(service.socketState(bindingId)!.error)).toMatch(/401/);
    fake.allowAuth();
    service.stopSocket(bindingId);
    service.startSocket(bindingId);
    expect(await waitConnected()).toMatchObject({ status: "connected" });
  });

  it("reconnects after an abrupt drop and after a gateway reconnect request", async () => {
    service.startSocket(bindingId);
    expect(await waitConnected()).toMatchObject({ status: "connected" });
    const identifiesBefore = fake.identifies;
    fake.dropSockets();
    for (let i = 0; i < 100 && fake.identifies <= identifiesBefore; i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(await waitConnected()).toMatchObject({ status: "connected" });
    fake.requestReconnect();
    for (let i = 0; i < 100 && fake.identifies <= identifiesBefore + 1; i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(await waitConnected()).toMatchObject({ status: "connected" });
  });
});
