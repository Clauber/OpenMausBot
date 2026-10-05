// The Telegram adapter through a real isolated runtime: the actual harness,
// webhook receiver and guarded-send path, with the fake CLI engine as the only
// provider and server/testing/fake-telegram.ts standing in for the Bot API.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "../../scripts/control-omb.ts";
import { startFakeTelegram, type FakeTelegram } from "../testing/fake-telegram.ts";

const TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef";
const PUBLIC_BASE = "https://bots.example.com";

describe("Telegram adapter through an isolated runtime", () => {
  let fixture: VerificationServer;
  let fake: FakeTelegram;
  let scratch: string;
  let evidence: unknown[];
  let webhookBase: string;

  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = { status: response.status, body: await response.json() as any };
    evidence.push({ method, path, body: path.includes("/messaging/") && method === "POST" ? "(redacted)" : body, result });
    return result;
  };
  const hook = async (bindingId: string, secret: string | undefined, update: unknown) => {
    const response = await fetch(`${webhookBase}/hooks/telegram/${bindingId}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(secret ? { "x-telegram-bot-api-secret-token": secret } : {}) },
      body: JSON.stringify(update),
    });
    const result = { status: response.status, body: await response.json() as any };
    evidence.push({ telegramWebhook: { bindingId, secretSent: Boolean(secret), update }, result });
    return result;
  };
  let updateId = 1000;
  const dm = (chat: number, text: string) => ({
    update_id: ++updateId,
    message: { message_id: updateId, text, chat: { id: chat, type: "private", first_name: "Ada" }, from: { id: chat, first_name: "Ada" } },
  });

  beforeEach(async () => {
    evidence = [];
    fake = await startFakeTelegram();
    scratch = mkdtempSync(join(tmpdir(), "omb-telegram-e2e-"));
    const state = join(scratch, "reply-state");
    writeFileSync(state, "");
    fixture = await launchVerificationServer({
      ...process.env,
      TELEGRAM_API_BASE: fake.url,
      FAKE_CLAUDE_REPLIES: JSON.stringify(["Four.", `${"lorem ipsum ".repeat(500)}END`]),
      FAKE_CLAUDE_REPLY_STATE: state,
    });
    webhookBase = `http://127.0.0.1:${Number(new URL(fixture.info.url).port) + 1}`;
  }, 30_000);

  afterEach(async () => {
    if (fixture) {
      const evidencePath = `${fixture.info.logPath}.telegram.json`;
      writeFileSync(evidencePath, JSON.stringify({ fixture: fixture.info, evidence, fakeOutbox: fake?.outbox, limitation: "Actual runtime, webhook receiver and guarded path with the fake engine and a fake Bot API only. No live accounts or user data." }, null, 2));
      console.info(JSON.stringify({ logPath: fixture.info.logPath, evidencePath }));
      await fixture.close();
    }
    await fake?.stop();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("registers a binding, rejects bad secrets, pairs by code, and replies in the chat", async () => {
    const control = async (args: string[]) => (await runControlOmb([...args, "--url", fixture.info.url])) as any;
    const { bot } = await control(["new-bot", "--name", "Telegram fixture"]);

    // binding + webhook registration against the fake Bot API
    expect((await api("POST", "/api/messaging/telegram", { botId: bot.id, token: "nope" })).status).toBe(400);
    expect((await api("POST", "/api/messaging/telegram", { botId: "missing", token: TOKEN })).status).toBe(404);
    const created = await api("POST", "/api/messaging/telegram", { botId: bot.id, token: TOKEN, publicBaseUrl: PUBLIC_BASE });
    expect(created.status).toBe(201);
    const { binding, secret, webhookUrl } = created.body;
    expect(webhookUrl).toBe(`${PUBLIC_BASE}/hooks/telegram/${binding.id}`);
    expect(fake.webhooks).toEqual([{ token: TOKEN, url: webhookUrl, secret_token: secret }]);
    const listed = await api("GET", "/api/messaging/telegram");
    expect(JSON.stringify(listed.body)).not.toContain(TOKEN);
    expect(JSON.stringify(listed.body)).not.toContain(secret);

    // wrong / missing secret
    expect((await hook(binding.id, "wrong-secret", dm(555, "hi"))).status).toBe(401);
    expect((await hook(binding.id, undefined, dm(555, "hi"))).status).toBe(401);
    expect((await hook("tg_nobody", secret, dm(555, "hi"))).status).toBe(401);
    expect(fake.outbox).toEqual([]);

    // unknown chat without an active code gets a hint only
    expect((await hook(binding.id, secret, dm(777, "hello?"))).status).toBe(200);
    expect((await fake.waitForOutbox("777"))[0]!.text).toMatch(/isn't paired/);

    // pairing: code generated through the admin API, spent once by chat 555
    const pairing = await api("POST", `/api/messaging/telegram/${binding.id}/pairing`, {});
    expect(pairing.body.code).toMatch(/^\d{6}$/);
    await hook(binding.id, secret, dm(555, "/start"));
    expect((await fake.waitForOutbox("555"))[0]!.text).toMatch(/didn't match/);
    await hook(binding.id, secret, dm(555, pairing.body.code));
    expect((await fake.waitForOutbox("555", 2))[1]!.text).toMatch(/^Paired with /);
    const bound = (await api("GET", `/api/messaging/telegram/${binding.id}`)).body.binding;
    expect(bound.chats).toHaveLength(1);
    expect(bound.chats[0]).toMatchObject({ chatId: "555", enabled: true });
    expect(bound.pairing).toBeNull();
    await hook(binding.id, secret, dm(888, pairing.body.code));
    expect((await fake.waitForOutbox("888"))[0]!.text).toMatch(/didn't match/);

    // a paired chat's message reaches the bot and its reply returns to that chat
    expect((await hook(binding.id, secret, dm(555, "What is 2+2?"))).status).toBe(200);
    const answered = await fake.waitForOutbox("555", 3);
    expect(answered[2]).toMatchObject({ chat_id: "555", text: "Four." });
    expect(fake.outbox.some((m) => m.chat_id === "777" && m.text === "Four.")).toBe(false);
    expect(fake.actions.some((a) => a.chat_id === "555" && a.action === "typing")).toBe(true);
    const thread = (await api("GET", `/api/threads/${bound.chats[0].threadId}/messages?limit=50`)).body.messages as any[];
    expect(thread.find((m) => m.role === "user" && m.text === "What is 2+2?")).toMatchObject({ relayed: true });

    // a long answer is split at Telegram's limit, in order
    await hook(binding.id, secret, dm(555, "Tell me a lot"));
    const parts = (await fake.waitForOutbox("555", 5)).slice(3);
    expect(parts.length).toBe(2);
    expect(parts.every((p) => p.text.length <= 4096)).toBe(true);
    expect(parts.map((p) => p.text).join(" ").replace(/\s+/g, " ")).toBe(`${"lorem ipsum ".repeat(500)}END`.replace(/\s+/g, " "));

    // unpairing: the chat stops being answered
    expect((await api("DELETE", `/api/messaging/telegram/${binding.id}/chats/555`)).status).toBe(200);
    await hook(binding.id, secret, dm(555, "still there?"));
    expect((await fake.waitForOutbox("555", 6))[5]!.text).toMatch(/isn't paired/);
    expect((await api("DELETE", `/api/messaging/telegram/${binding.id}`)).status).toBe(200);
    expect(fake.webhooks).toEqual([]);
    expect((await hook(binding.id, secret, dm(555, "gone"))).status).toBe(401);
  }, 90_000);
});
