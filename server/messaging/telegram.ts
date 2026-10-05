// Telegram Bot API client. Only the calls the adapter needs, over fetch, with
// the API base overridable (TELEGRAM_API_BASE) so tests and the isolated
// fixture talk to server/testing/fake-telegram.ts instead of Telegram.
import { z } from "zod";

export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;
export const DEFAULT_TELEGRAM_API_BASE = "https://api.telegram.org";

export function telegramApiBase(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.TELEGRAM_API_BASE?.trim();
  return (raw || DEFAULT_TELEGRAM_API_BASE).replace(/\/+$/, "");
}

export class TelegramApiError extends Error {
  readonly status: number;
  constructor(method: string, status: number, description: string) {
    super(`Telegram ${method} failed (${status}): ${description}`);
    this.status = status;
  }
}

const envelopeSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  description: z.string().optional(),
  error_code: z.number().int().optional(),
});
const meSchema = z.object({ id: z.number(), is_bot: z.boolean().optional(), username: z.string().optional(), first_name: z.string().optional() });
export type TelegramMe = z.infer<typeof meSchema>;
const webhookInfoSchema = z.object({
  url: z.string(),
  pending_update_count: z.number().int().optional(),
  last_error_date: z.number().optional(),
  last_error_message: z.string().optional(),
});
export type TelegramWebhookInfo = z.infer<typeof webhookInfoSchema>;

export interface TelegramClient {
  getMe(): Promise<TelegramMe>;
  setWebhook(url: string, secretToken: string): Promise<void>;
  deleteWebhook(): Promise<void>;
  getWebhookInfo(): Promise<TelegramWebhookInfo>;
  sendChatAction(chatId: string, action?: "typing"): Promise<void>;
  /** One message of at most 4096 characters. */
  sendMessage(chatId: string, text: string, parseMode?: "MarkdownV2"): Promise<void>;
  /** Splits on the 4096 limit and sends in order. With `markdown`, a part
   * Telegram rejects (400: bad entity escaping) is resent as plain text. */
  sendText(chatId: string, text: string, options?: { markdown?: boolean }): Promise<number>;
}

/** Split on paragraph, line, then word boundaries, falling back to a hard cut. */
export function splitTelegramText(text: string, limit = TELEGRAM_MAX_MESSAGE_CHARS): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" "));
    if (cut < limit / 2) cut = limit;
    // never split a surrogate pair
    if (cut === limit && /[\uD800-\uDBFF]/.test(window[limit - 1] ?? "")) cut = limit - 1;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest.trim()) parts.push(rest);
  return parts.length ? parts : [text];
}

export function createTelegramClient(options: { token: string; apiBase?: string; fetchImpl?: typeof fetch }): TelegramClient {
  const base = (options.apiBase ?? telegramApiBase()).replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  async function call(method: string, body?: Record<string, unknown>): Promise<unknown> {
    let response: Response;
    try {
      response = await doFetch(`${base}/bot${options.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      // the URL carries the token; keep it out of the surfaced message
      throw new TelegramApiError(method, 0, error instanceof Error ? error.name : "network error");
    }
    const parsed = envelopeSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success || !parsed.data.ok) {
      throw new TelegramApiError(method, parsed.success ? parsed.data.error_code ?? response.status : response.status,
        parsed.success ? parsed.data.description ?? "request refused" : "unreadable response");
    }
    return parsed.data.result;
  }
  const sendMessage = async (chatId: string, text: string, parseMode?: "MarkdownV2") => {
    await call("sendMessage", { chat_id: chatId, text, ...(parseMode ? { parse_mode: parseMode } : {}) });
  };
  return {
    async getMe() { return meSchema.parse(await call("getMe")); },
    async setWebhook(url, secretToken) {
      await call("setWebhook", { url, secret_token: secretToken, allowed_updates: ["message"] });
    },
    async deleteWebhook() { await call("deleteWebhook"); },
    async getWebhookInfo() { return webhookInfoSchema.parse(await call("getWebhookInfo")); },
    async sendChatAction(chatId, action = "typing") { await call("sendChatAction", { chat_id: chatId, action }); },
    sendMessage,
    async sendText(chatId, text, opts) {
      const parts = splitTelegramText(text);
      for (const part of parts) {
        if (opts?.markdown) {
          try { await sendMessage(chatId, part, "MarkdownV2"); continue; }
          catch (error) { if (!(error instanceof TelegramApiError) || error.status !== 400) throw error; }
        }
        await sendMessage(chatId, part);
      }
      return parts.length;
    },
  };
}
