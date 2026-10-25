// Drives the Telegram adapter end to end against a disposable runtime and the
// fake Bot API, then prints the evidence JSON: the registered binding, the
// 401s, the pairing exchange, the reply that reached the fake's outbox, and
// the transcript line that reply came from.
//
//   node --experimental-strip-types scripts/verify-telegram.ts
//       launches its own fixture and fake Bot API, and stops both.
//   node --experimental-strip-types scripts/verify-telegram.ts --url http://127.0.0.1:PORT --fake http://127.0.0.1:FAKE
//       attaches to a `control-omb launch` fixture that was started with
//       TELEGRAM_API_BASE=<fake url> (see docs/verification/telegram.md).
import { writeFileSync } from "node:fs";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "./control-omb.ts";
import { startFakeTelegram, type FakeTelegram } from "../server/testing/fake-telegram.ts";

const flag = (name: string) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const attachedUrl = flag("--url");
const attachedFake = flag("--fake");
const TOKEN = "123456:VERIFYTELEGRAMFIXTURETOKEN_0123456789";
const evidence: unknown[] = [];

let fake: FakeTelegram | undefined;
let fixture: VerificationServer | undefined;
const fakeUrl = attachedFake ?? (fake = await startFakeTelegram()).url;
const harness = attachedUrl ?? (fixture = await launchVerificationServer({ ...process.env, TELEGRAM_API_BASE: fakeUrl })).info.url;
const webhookBase = `http://127.0.0.1:${Number(new URL(harness).port) + 1}`;

const assert = (ok: unknown, what: string) => { if (!ok) throw new Error(`verify-telegram: ${what}`); evidence.push({ check: what, ok: true }); };
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${harness}${path}`, {
    method, headers: { "content-type": "application/json", origin: harness },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as any };
};
const outbox = async (): Promise<Array<{ chat_id: string; text: string }>> => (await (await fetch(`${fakeUrl}/outbox`)).json()) as any;
const actions = async (): Promise<Array<{ chat_id: string; action: string }>> => (await (await fetch(`${fakeUrl}/actions`)).json()) as any;
const waitOutbox = async (chatId: string, count: number) => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const mine = (await outbox()).filter((m) => m.chat_id === chatId);
    if (mine.length >= count) return mine;
    if (Date.now() > deadline) throw new Error(`verify-telegram: timed out waiting for ${count} message(s) to chat ${chatId}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
let updateId = 5000;
const hook = async (bindingId: string, secret: string | undefined, chat: number, text: string) => {
  const response = await fetch(`${webhookBase}/hooks/telegram/${bindingId}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret ? { "x-telegram-bot-api-secret-token": secret } : {}) },
    body: JSON.stringify({ update_id: ++updateId, message: { message_id: updateId, text, chat: { id: chat, type: "private", first_name: "Ada" }, from: { id: chat, first_name: "Ada" } } }),
  });
  return response.status;
};

try {
  const { bot } = await runControlOmb(["new-bot", "--name", "Telegram verification", "--url", harness]) as any;
  const created = await api("POST", "/api/messaging/telegram", { botId: bot.id, token: TOKEN, publicBaseUrl: "https://bots.example.com" });
  assert(created.status === 201, "binding created and webhook registered with the (fake) Bot API");
  const { binding, secret, webhookUrl } = created.body;
  evidence.push({ binding, webhookUrl, webhook: created.body.webhook });

  assert(await hook(binding.id, "wrong", 555, "hi") === 401, "wrong secret is rejected with 401");
  assert(await hook(binding.id, undefined, 555, "hi") === 401, "missing secret is rejected with 401");

  const { body: pairing } = await api("POST", `/api/messaging/telegram/${binding.id}/pairing`, {});
  await hook(binding.id, secret, 555, pairing.code);
  const paired = await waitOutbox("555", 1);
  assert(paired[0]!.text.startsWith("Paired with "), "unknown chat sending the code is paired");
  evidence.push({ pairing: { chat: "555", sent: "(six-digit code)", reply: paired[0]!.text } });
  await hook(binding.id, secret, 888, pairing.code);
  assert(/didn't match/.test((await waitOutbox("888", 1))[0]!.text), "the code is single use");

  await hook(binding.id, secret, 555, "Say something short.");
  const reply = (await waitOutbox("555", 2))[1]!;
  const chat = (await api("GET", `/api/messaging/telegram/${binding.id}`)).body.binding.chats[0];
  const transcript = (await api("GET", `/api/threads/${chat.threadId}/messages?limit=50`)).body.messages as any[];
  const answer = transcript.findLast((m) => m.role === "bot" && m.kind === "text" && m.turnTerminal);
  assert(reply.chat_id === "555" && reply.text.length > 0, "the reply reached the fake outbox addressed to the paired chat");
  assert(reply.text === answer?.text, "the reply is exactly the bot's closing transcript message");
  assert(transcript.some((m) => m.role === "user" && m.text === "Say something short." && m.relayed === true), "the message entered the thread through the guarded (relayed) path");
  assert((await actions()).some((a) => a.chat_id === "555" && a.action === "typing"), "typing was shown while the turn ran");
  evidence.push({ outboxReply: reply, transcript: transcript.map(({ role, kind, text, relayed, turnTerminal }) => ({ role, kind, text, relayed, turnTerminal })) });

  assert((await api("DELETE", `/api/messaging/telegram/${binding.id}`)).status === 200, "binding removed");
  assert(await hook(binding.id, secret, 555, "gone") === 401, "a removed binding answers 401");
  const out = { ok: true, harness, fake: fakeUrl, evidence };
  if (fixture) writeFileSync(`${fixture.info.logPath}.telegram-verify.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), evidence }, null, 2));
  process.exitCode = 1;
} finally {
  await fixture?.close();
  await fake?.stop();
}
