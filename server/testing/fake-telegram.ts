#!/usr/bin/env node
// A loopback stand-in for the Telegram Bot API, for tests and the isolated
// fixture. Implements /bot<token>/{getMe,setWebhook,deleteWebhook,
// getWebhookInfo,sendMessage,sendChatAction}; sends are captured in memory and
// readable at GET /outbox (also /actions, /webhooks) for assertions. A
// MarkdownV2 message containing "FAIL_MARKDOWN" is refused with a 400 like
// Telegram's bad-entity error, to exercise the plain-text fallback.
// Self-contained on purpose (node built-ins only).
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

export interface FakeTelegramSend { token: string; chat_id: string; text: string; parse_mode?: string; at: number }
export interface FakeTelegram {
  url: string;
  outbox: FakeTelegramSend[];
  actions: Array<{ token: string; chat_id: string; action: string }>;
  webhooks: Array<{ token: string; url: string; secret_token?: string }>;
  /** Wait until `count` messages exist for `chatId`, and return that chat's messages. */
  waitForOutbox(chatId: string, count?: number, timeoutMs?: number): Promise<FakeTelegramSend[]>;
  stop(): Promise<void>;
}

export async function startFakeTelegram(options: { port?: number } = {}): Promise<FakeTelegram> {
  const outbox: FakeTelegramSend[] = [];
  const actions: FakeTelegram["actions"] = [];
  const webhooks: FakeTelegram["webhooks"] = [];
  const reply = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/outbox") return reply(res, 200, outbox);
    if (req.method === "GET" && url.pathname === "/actions") return reply(res, 200, actions);
    if (req.method === "GET" && url.pathname === "/webhooks") return reply(res, 200, webhooks);
    const match = url.pathname.match(/^\/bot([^/]+)\/(\w+)$/);
    if (!match || req.method !== "POST") return reply(res, 404, { ok: false, error_code: 404, description: "Not Found" });
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    let body: Record<string, any> = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { /* empty */ }
    const [, token, method] = match as [string, string, string];
    if (token.startsWith("bad")) return reply(res, 401, { ok: false, error_code: 401, description: "Unauthorized" });
    switch (method) {
      case "getMe": return reply(res, 200, { ok: true, result: { id: 424242, is_bot: true, first_name: "Fake OMB", username: "fake_omb_bot" } });
      case "setWebhook":
        webhooks.push({ token, url: String(body.url), secret_token: body.secret_token });
        return reply(res, 200, { ok: true, result: true, description: "Webhook was set" });
      case "deleteWebhook": webhooks.length = 0; return reply(res, 200, { ok: true, result: true });
      case "getWebhookInfo": return reply(res, 200, { ok: true, result: { url: webhooks.at(-1)?.url ?? "", pending_update_count: 0 } });
      case "sendChatAction":
        actions.push({ token, chat_id: String(body.chat_id), action: String(body.action) });
        return reply(res, 200, { ok: true, result: true });
      case "sendMessage": {
        const text = String(body.text ?? "");
        if (text.length > 4096) return reply(res, 400, { ok: false, error_code: 400, description: "Bad Request: message is too long" });
        if (body.parse_mode === "MarkdownV2" && text.includes("FAIL_MARKDOWN")) {
          return reply(res, 400, { ok: false, error_code: 400, description: "Bad Request: can't parse entities" });
        }
        outbox.push({ token, chat_id: String(body.chat_id), text, ...(body.parse_mode ? { parse_mode: String(body.parse_mode) } : {}), at: Date.now() });
        return reply(res, 200, { ok: true, result: { message_id: outbox.length, chat: { id: body.chat_id }, text } });
      }
      default: return reply(res, 404, { ok: false, error_code: 404, description: "Not Found" });
    }
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    outbox, actions, webhooks,
    async waitForOutbox(chatId, count = 1, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const mine = outbox.filter((m) => m.chat_id === chatId);
        if (mine.length >= count) return mine;
        if (Date.now() > deadline) throw new Error(`fake Telegram: timed out waiting for ${count} message(s) to chat ${chatId}; have ${mine.length}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    stop() {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// `node --experimental-strip-types server/testing/fake-telegram.ts [port]`
// prints the base URL for TELEGRAM_API_BASE and runs until killed.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fake = await startFakeTelegram({ port: Number(process.argv[2]) || 0 });
  process.stdout.write(`${fake.url}\n`);
}
