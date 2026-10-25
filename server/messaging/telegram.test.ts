import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startFakeTelegram, type FakeTelegram } from "../testing/fake-telegram.ts";
import { PAIRING_MAX_FAILURES, TelegramBindingStore } from "./telegram-store.ts";
import { TelegramService, type TelegramHost, type TelegramPhase } from "./telegram-service.ts";
import { createTelegramClient, splitTelegramText, TelegramApiError, telegramApiBase } from "./telegram.ts";

const TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef";
let fake: FakeTelegram;
let dir: string;

beforeEach(async () => {
  fake = await startFakeTelegram();
  dir = mkdtempSync(join(tmpdir(), "omb-telegram-"));
});
afterEach(async () => {
  await fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("telegram client", () => {
  it("defaults to the real API base and honours TELEGRAM_API_BASE", () => {
    expect(telegramApiBase({})).toBe("https://api.telegram.org");
    expect(telegramApiBase({ TELEGRAM_API_BASE: "http://127.0.0.1:9/" })).toBe("http://127.0.0.1:9");
  });

  it("speaks getMe, setWebhook, getWebhookInfo, sendChatAction and deleteWebhook", async () => {
    const client = createTelegramClient({ token: TOKEN, apiBase: fake.url });
    expect((await client.getMe()).username).toBe("fake_omb_bot");
    await client.setWebhook("https://example.com/hooks/telegram/tg_x", "s3cret");
    expect(fake.webhooks).toEqual([{ token: TOKEN, url: "https://example.com/hooks/telegram/tg_x", secret_token: "s3cret" }]);
    expect((await client.getWebhookInfo()).url).toBe("https://example.com/hooks/telegram/tg_x");
    await client.sendChatAction("77");
    expect(fake.actions).toEqual([{ token: TOKEN, chat_id: "77", action: "typing" }]);
    await client.deleteWebhook();
    expect(fake.webhooks).toEqual([]);
  });

  it("splits long replies at 4096 characters, in order, losing nothing", async () => {
    const client = createTelegramClient({ token: TOKEN, apiBase: fake.url });
    const text = Array.from({ length: 1500 }, (_, i) => `word${i}`).join(" ");
    expect(text.length).toBeGreaterThan(8192);
    const count = await client.sendText("5", text);
    const sent = fake.outbox.map((m) => m.text);
    expect(count).toBe(sent.length);
    expect(sent.length).toBeGreaterThanOrEqual(3);
    expect(sent.every((part) => part.length <= 4096)).toBe(true);
    expect(sent.join(" ")).toBe(text);
    // one unbroken run still cuts at the limit
    expect(splitTelegramText("x".repeat(9000)).map((p) => p.length)).toEqual([4096, 4096, 808]);
  });

  it("falls back to plain text when MarkdownV2 is refused with a 400", async () => {
    const client = createTelegramClient({ token: TOKEN, apiBase: fake.url });
    await client.sendText("5", "bad *entity FAIL_MARKDOWN", { markdown: true });
    expect(fake.outbox).toHaveLength(1);
    expect(fake.outbox[0]).toMatchObject({ chat_id: "5", text: "bad *entity FAIL_MARKDOWN" });
    expect(fake.outbox[0]!.parse_mode).toBeUndefined();
    await client.sendText("5", "fine", { markdown: true });
    expect(fake.outbox[1]).toMatchObject({ text: "fine", parse_mode: "MarkdownV2" });
  });

  it("does not put the token in surfaced errors", async () => {
    const client = createTelegramClient({ token: "bad:token", apiBase: fake.url });
    const error = await client.getMe().catch((e) => e);
    expect(error).toBeInstanceOf(TelegramApiError);
    expect(error.status).toBe(401);
    const dead = createTelegramClient({ token: TOKEN, apiBase: "http://127.0.0.1:1" });
    expect(String(await dead.getMe().catch((e) => e.message))).not.toContain(TOKEN);
  });

  it("long-polls getUpdates and returns updates at or above the offset", async () => {
    const client = createTelegramClient({ token: TOKEN, apiBase: fake.url });
    expect(await client.getUpdates(1, 1)).toEqual([]);
    expect(fake.getUpdatesCalls.at(-1)).toMatchObject({ token: TOKEN, offset: 1, timeout: 1 });
    fake.pushUpdate({ message: { message_id: 5, text: "hi", chat: { id: 42, type: "private" } } });
    fake.pushUpdate({ message: { message_id: 6, text: "ho", chat: { id: 42, type: "private" } } });
    const got = await client.getUpdates(1, 5);
    expect(got.map((u) => u.update_id)).toEqual([1, 2]);
    // everything below the offset stays delivered-silent
    expect((await client.getUpdates(2, 1)).map((u) => u.update_id)).toEqual([2]);
  });
});

describe("binding store", () => {
  it("leaves saved bindings without a transport unresolved", () => {
    const store = new TelegramBindingStore(dir);
    const binding = store.create({ botId: "bot1", token: TOKEN });
    const file = join(dir, "messaging", "telegram.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    delete saved.bindings[binding.id].transport;
    writeFileSync(file, JSON.stringify(saved));
    expect(new TelegramBindingStore(dir).get(binding.id)?.transport).toBeUndefined();
  });

  it("keeps new polling bindings on polling after reload", () => {
    const store = new TelegramBindingStore(dir);
    const binding = store.create({ botId: "bot1", token: TOKEN });
    expect(binding.transport).toBe("poll");
    expect(new TelegramBindingStore(dir).get(binding.id)?.transport).toBe("poll");
  });

  it("persists and reloads with private POSIX permissions", () => {
    const store = new TelegramBindingStore(dir);
    const binding = store.create({ botId: "bot1", token: TOKEN });
    store.bindChat(binding.id, "42", { threadId: "thr", name: "Ada" });
    if (process.platform !== "win32") expect(statSync(join(dir, "messaging", "telegram.json")).mode & 0o777).toBe(0o600);
    const reloaded = new TelegramBindingStore(dir).get(binding.id)!;
    expect(reloaded).toMatchObject({ botId: "bot1", token: TOKEN, secret: binding.secret, chats: { "42": { threadId: "thr", enabled: true } } });
    expect(binding.secret).toMatch(/^[A-Za-z0-9_-]{32,}$/);
  });

  it("pairing codes are 6 digits, single use, expiring, and burn after repeated misses", () => {
    let now = 1_000_000;
    const store = new TelegramBindingStore(dir, () => now);
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
    for (let i = 0; i < PAIRING_MAX_FAILURES; i += 1) expect(store.tryPairingCode(id, wrong)).toBe(false);
    expect(store.tryPairingCode(id, third)).toBe(false);
  });
});

describe("telegram service", () => {
  let store: TelegramBindingStore;
  let service: TelegramService;
  let started: Array<{ threadId: string; text: string; sendId: string }>;
  let phases: TelegramPhase[];
  let bindingId: string;
  let secret: string;
  let threads = 0;

  const host: TelegramHost = {
    botName: () => "Pepper",
    createThread: () => `thread-${++threads}`,
    threadExists: () => true,
    startTurn: async (input) => { started.push(input); return { ok: true }; },
    readRequest: (_bot, _thread, sendId) => {
      const phase = phases.shift() ?? "settled";
      const text = started.find((s) => s.sendId === sendId)!.text;
      return phase === "settled" ? { phase, reply: text.startsWith("LONG") ? "y".repeat(5000) : `echo: ${text}` } : { phase };
    },
  };
  const update = (id: number, chat: number, text?: string, extra: Record<string, unknown> = {}) => ({
    update_id: id,
    message: { message_id: id, ...(text === undefined ? {} : { text }), chat: { id: chat, type: "private", first_name: "Ada" }, from: { id: chat, first_name: "Ada" }, ...extra },
  });

  beforeEach(() => {
    started = []; phases = []; threads = 0;
    store = new TelegramBindingStore(dir);
    const binding = store.create({ botId: "bot1", token: TOKEN });
    bindingId = binding.id; secret = binding.secret;
    service = new TelegramService({
      store, host, pollMs: 5, typingMs: 1, maxWaitMs: 5_000,
      clientFor: (b) => createTelegramClient({ token: b.token, apiBase: fake.url }),
    });
  });

  it("rejects a wrong or missing secret and an unknown binding with the same 401", async () => {
    store.bindChat(bindingId, "42", { threadId: "t" });
    expect(service.receive(bindingId, "nope", update(1, 42, "hi")).status).toBe(401);
    expect(service.receive(bindingId, undefined, update(1, 42, "hi")).status).toBe(401);
    expect(service.receive("tg_missing", secret, update(1, 42, "hi")).status).toBe(401);
    await service.idle();
    expect(started).toEqual([]);
    expect(fake.outbox).toEqual([]);
  });

  it("replies to a bound chat's message with the bot's answer, addressed to that chat", async () => {
    store.bindChat(bindingId, "42", { threadId: "t-42" });
    phases = ["working", "working"];
    expect(service.receive(bindingId, secret, update(10, 42, "hello bot")).status).toBe(200);
    const [reply] = await fake.waitForOutbox("42");
    expect(reply).toMatchObject({ chat_id: "42", text: "echo: hello bot" });
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ threadId: "t-42", text: "hello bot" });
    expect(started[0]!.sendId).toMatch(/^[A-Za-z0-9_-]{16,80}$/);
    expect(fake.actions.some((a) => a.chat_id === "42" && a.action === "typing")).toBe(true);
    // Telegram redelivering the same update starts nothing new
    expect(service.receive(bindingId, secret, update(10, 42, "hello bot")).body).toMatchObject({ duplicate: true });
    await service.idle();
    expect(started).toHaveLength(1);
  });

  it("splits a reply over 4096 characters into ordered messages", async () => {
    store.bindChat(bindingId, "42", { threadId: "t-42" });
    service.receive(bindingId, secret, update(11, 42, "LONG please"));
    const parts = await fake.waitForOutbox("42", 2);
    expect(parts.map((p) => p.text.length)).toEqual([4096, 904]);
  });

  it("tells the chat when the bot is waiting for approval, then still delivers the reply", async () => {
    store.bindChat(bindingId, "42", { threadId: "t-42" });
    phases = ["waiting", "waiting", "settled"];
    service.receive(bindingId, secret, update(12, 42, "do the thing"));
    const messages = await fake.waitForOutbox("42", 2);
    expect(messages[0]!.text).toMatch(/needs your approval/);
    expect(messages[1]!.text).toBe("echo: do the thing");
  });

  it("pairs an unknown chat with the active code, once, then replies to it", async () => {
    const { code } = store.startPairing(bindingId)!;
    service.receive(bindingId, secret, update(20, 99, "hello?"));
    expect((await fake.waitForOutbox("99"))[0]!.text).toMatch(/didn't match/);
    expect(started).toEqual([]);
    service.receive(bindingId, secret, update(21, 99, `/start ${code}`));
    expect((await fake.waitForOutbox("99", 2))[1]!.text).toBe("Paired with Pepper. Send a message to start.");
    expect(store.get(bindingId)!.chats["99"]).toMatchObject({ threadId: "thread-1", enabled: true });
    expect(started).toEqual([]);
    service.receive(bindingId, secret, update(22, 99, "now it works"));
    expect((await fake.waitForOutbox("99", 3))[2]!.text).toBe("echo: now it works");
    expect(started[0]).toMatchObject({ threadId: "thread-1", text: "now it works" });
    // single use: a second chat cannot reuse the code
    service.receive(bindingId, secret, update(23, 100, code));
    expect((await fake.waitForOutbox("100"))[0]!.text).toMatch(/didn't match/);
    expect(store.get(bindingId)!.chats["100"]).toBeUndefined();
  });

  it("ignores unknown chats silently of content, groups, and disabled chats", async () => {
    store.bindChat(bindingId, "42", { threadId: "t" });
    store.setChatEnabled(bindingId, "42", false);
    service.receive(bindingId, secret, update(30, 42, "muted"));
    service.receive(bindingId, secret, { update_id: 31, message: { message_id: 31, text: "group", chat: { id: -5, type: "group" } } });
    await service.idle();
    expect(started).toEqual([]);
    expect(fake.outbox).toEqual([]);
  });

  it("reports a refused send to the chat instead of staying silent", async () => {
    store.bindChat(bindingId, "42", { threadId: "t" });
    const refusing = new TelegramService({
      store, pollMs: 5,
      host: { ...host, startTurn: async () => ({ ok: false, error: "Couldn't reach the bot: busy" }) },
      clientFor: (b) => createTelegramClient({ token: b.token, apiBase: fake.url }),
    });
    refusing.receive(bindingId, secret, update(40, 42, "hi"));
    expect((await fake.waitForOutbox("42"))[0]!.text).toBe("Couldn't reach the bot: busy");
  });
});

describe("telegram long-poll transport", () => {
  let store: TelegramBindingStore;
  let service: TelegramService;
  let started: Array<{ threadId: string; text: string; sendId: string }>;
  let phases: TelegramPhase[];
  let bindingId: string;
  let threads = 0;

  const host: TelegramHost = {
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
  const privateMessage = (chat: number, text: string) => ({
    message: { message_id: Date.now() % 100000, text, chat: { id: chat, type: "private", first_name: "Ada" }, from: { id: chat, first_name: "Ada" } },
  });

  beforeEach(() => {
    started = []; phases = []; threads = 0;
    store = new TelegramBindingStore(dir);
    const binding = store.create({ botId: "bot1", token: TOKEN });
    bindingId = binding.id;
    service = new TelegramService({
      store, host, pollMs: 5, typingMs: 1, maxWaitMs: 5_000, getUpdatesTimeoutS: 1, backoffMs: 20,
      clientFor: (b) => createTelegramClient({ token: b.token, apiBase: fake.url }),
    });
  });

  afterEach(() => { service.stop(); });

  const loadLegacy = () => {
    const file = join(dir, "messaging", "telegram.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    delete saved.bindings[bindingId].transport;
    writeFileSync(file, JSON.stringify(saved));
    store = new TelegramBindingStore(dir);
    service.stop();
    service = new TelegramService({
      store, host, getUpdatesTimeoutS: 1,
      clientFor: (b) => createTelegramClient({ token: b.token, apiBase: fake.url }),
    });
  };

  it("preserves an active webhook when a saved transport is missing", async () => {
    loadLegacy();
    const client = createTelegramClient({ token: TOKEN, apiBase: fake.url });
    await client.setWebhook("https://example.com/hooks/telegram/legacy", "secret");
    service.startAll();
    await expect.poll(() => store.get(bindingId)?.transport).toBe("webhook");
    expect(fake.webhooks).toHaveLength(1);
    expect(fake.getUpdatesCalls).toHaveLength(0);
  });

  it("resumes polling without deleting a webhook when discovery finds no webhook", async () => {
    loadLegacy();
    let deletes = 0;
    service = new TelegramService({
      store, host, getUpdatesTimeoutS: 1,
      clientFor: (b) => ({
        ...createTelegramClient({ token: b.token, apiBase: fake.url }),
        deleteWebhook: async () => { deletes += 1; },
      }),
    });
    service.startAll();
    await expect.poll(() => fake.getUpdatesCalls.length).toBeGreaterThan(0);
    expect(store.get(bindingId)?.transport).toBe("poll");
    expect(deletes).toBe(0);
  });

  it("reports discovery failure without deleting a webhook or starting polling", async () => {
    loadLegacy();
    let deletes = 0;
    service = new TelegramService({
      store, host,
      clientFor: (b) => ({
        ...createTelegramClient({ token: b.token, apiBase: fake.url }),
        getWebhookInfo: async () => { throw new Error("lookup unavailable"); },
        deleteWebhook: async () => { deletes += 1; },
      }),
    });
    service.startAll();
    await expect.poll(() => service.pollerState(bindingId)?.status).toBe("error");
    expect(service.pollerState(bindingId)?.error).toContain("lookup unavailable");
    expect(store.get(bindingId)?.transport).toBeUndefined();
    expect(fake.getUpdatesCalls).toHaveLength(0);
    expect(deletes).toBe(0);
  });

  it("keeps restarted discovery active when an aborted lookup finishes", async () => {
    loadLegacy();
    let resolve!: (info: { url: string }) => void;
    const first = new Promise<{ url: string }>((done) => { resolve = done; });
    let calls = 0;
    service = new TelegramService({
      store, host, getUpdatesTimeoutS: 1,
      clientFor: (b) => ({
        ...createTelegramClient({ token: b.token, apiBase: fake.url }),
        getWebhookInfo: async () => ++calls === 1 ? first : { url: "" },
      }),
    });
    service.startAll();
    service.stopPolling(bindingId);
    service.startPolling(bindingId);
    await expect.poll(() => fake.getUpdatesCalls.length).toBeGreaterThan(0);
    resolve({ url: "https://example.com/stale" });
    await new Promise<void>((done) => setImmediate(done));
    expect(store.get(bindingId)?.transport).toBe("poll");
    expect(service.pollerState(bindingId)?.status).toBe("polling");
  });

  it("does not apply discovery after the service stops", async () => {
    loadLegacy();
    let resolve!: (info: { url: string }) => void;
    const info = new Promise<{ url: string }>((done) => { resolve = done; });
    service = new TelegramService({
      store, host,
      clientFor: (b) => ({
        ...createTelegramClient({ token: b.token, apiBase: fake.url }),
        getWebhookInfo: () => info,
      }),
    });
    service.startAll();
    service.stop();
    resolve({ url: "" });
    await expect.poll(() => service.pollerState(bindingId)?.status).toBe("stopped");
    expect(store.get(bindingId)?.transport).toBeUndefined();
    expect(fake.getUpdatesCalls).toHaveLength(0);
  });

  it("polls by default, relays updates like the webhook path, and persists the offset", async () => {
    service.startPolling(bindingId);
    const { code } = store.startPairing(bindingId)!;
    fake.pushUpdate(privateMessage(55, "/start"));
    const hello = await fake.waitForOutbox("55");
    expect(hello[0]!.text).toMatch(/didn't match|Paired with/);
    fake.pushUpdate(privateMessage(55, code));
    expect((await fake.waitForOutbox("55", 2))[1]!.text).toMatch(/^Paired with /);
    phases = ["settled"];
    fake.pushUpdate(privateMessage(55, "hello bot"));
    expect((await fake.waitForOutbox("55", 3))[2]!.text).toBe("echo: hello bot");
    expect(started).toHaveLength(1);
    // the cursor advanced past every delivered update, so a restart sees none of them again
    await service.idle();
    const offset = store.get(bindingId)!.pollOffset;
    expect(offset).toBe(fake.getUpdatesCalls.at(-1)!.offset - 1);
    expect(fake.getUpdatesCalls.at(-1)!.offset).toBeGreaterThan(1);
  });

  it("resumes from the stored offset after a restart without replaying turns", async () => {
    // a seed update below the cursor stands for everything already answered
    fake.pushUpdate(privateMessage(1, "seed"));
    store.setPollOffset(bindingId, 1);
    service.startPolling(bindingId);
    for (let i = 0; i < 100 && !fake.getUpdatesCalls.length; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(fake.getUpdatesCalls[0]).toMatchObject({ offset: 2 });
    store.bindChat(bindingId, "77", { threadId: "t77" });
    phases = ["settled"];
    fake.pushUpdate(privateMessage(77, "fresh"));
    expect((await fake.waitForOutbox("77"))[0]!.text).toBe("echo: fresh");
    await service.idle();
    expect(started).toHaveLength(1);
    // a second service over the same store sees only the advanced cursor
    const again = new TelegramService({
      store, host: { ...host, startTurn: async (input) => { started.push(input); return { ok: true }; } },
      pollMs: 5, typingMs: 1, maxWaitMs: 5_000, getUpdatesTimeoutS: 1, backoffMs: 20,
      clientFor: (b) => createTelegramClient({ token: b.token, apiBase: fake.url }),
    });
    again.startPolling(bindingId);
    await new Promise((r) => setTimeout(r, 150));
    expect(started).toHaveLength(1); // no replay
    again.stop();
  });

  it("surfaces a webhook conflict as an error state and recovers on demand", async () => {
    fake.refuseGetUpdates();
    service.startPolling(bindingId);
    for (let i = 0; i < 100 && service.pollerState(bindingId)?.status !== "error"; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(service.pollerState(bindingId)).toMatchObject({ status: "error" });
    expect(String(service.pollerState(bindingId)!.error)).toMatch(/409/);
    // the operator clears the conflicting webhook; a restart polls again
    fake.allowGetUpdates();
    service.stopPolling(bindingId);
    service.startPolling(bindingId);
    for (let i = 0; i < 100 && service.pollerState(bindingId)?.status !== "polling"; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(service.pollerState(bindingId)!.status).toBe("polling");
  });

  it("stops when the binding switches to webhook delivery or the service stops", async () => {
    service.startPolling(bindingId);
    for (let i = 0; i < 100 && !fake.getUpdatesCalls.length; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(fake.getUpdatesCalls.length).toBeGreaterThan(0);
    // switch to webhook: the poller exits (an in-flight long poll unwinds first)
    store.setTransport(bindingId, "webhook");
    for (let i = 0; i < 300 && service.pollerState(bindingId)?.status !== "stopped"; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(service.pollerState(bindingId)!.status).toBe("stopped");
    const callsAfterSwitch = fake.getUpdatesCalls.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(fake.getUpdatesCalls.length).toBe(callsAfterSwitch);
    // service stop aborts an in-flight long poll promptly
    store.setTransport(bindingId, "poll");
    service.startPolling(bindingId);
    for (let i = 0; i < 100 && service.pollerState(bindingId)?.status !== "polling"; i += 1) await new Promise((r) => setTimeout(r, 10));
    service.stop();
    for (let i = 0; i < 300 && service.pollerState(bindingId)?.status !== "stopped"; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(service.pollerState(bindingId)!.status).toBe("stopped");
    const callsAtEnd = fake.getUpdatesCalls.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(fake.getUpdatesCalls.length).toBe(callsAtEnd);
  });
});
