import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startFakeTelegram, type FakeTelegram } from "../testing/fake-telegram.ts";
import { PAIRING_MAX_FAILURES, TelegramBindingStore } from "./store.ts";
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
});

describe("binding store", () => {
  it("persists at mode 0600 and reloads", () => {
    const store = new TelegramBindingStore(dir);
    const binding = store.create({ botId: "bot1", token: TOKEN });
    store.bindChat(binding.id, "42", { threadId: "thr", name: "Ada" });
    expect(statSync(join(dir, "messaging", "telegram.json")).mode & 0o777).toBe(0o600);
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
