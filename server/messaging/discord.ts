// Discord REST client. Only the calls the adapter needs, over fetch, with the
// API base overridable (DISCORD_API_BASE) so tests and the isolated fixture
// talk to server/testing/fake-discord.ts instead of Discord. References
// pulled 2026-10-11: docs.discord.com/developers/topics/gateway,
// .../topics/gateway-events, .../resources/message.
import { z } from "zod";

export const DEFAULT_DISCORD_API_BASE = "https://discord.com/api/v10";
/** Create Message: content holds "up to 2000 characters". */
export const DISCORD_MAX_MESSAGE_CHARS = 2000;

export function discordApiBase(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.DISCORD_API_BASE?.trim();
  return (raw || DEFAULT_DISCORD_API_BASE).replace(/\/+$/, "");
}

export class DiscordApiError extends Error {
  readonly status: number;
  constructor(method: string, status: number, description: string) {
    super(`Discord ${method} failed (${status}): ${description}`);
    this.status = status;
  }
}

const meSchema = z.object({ id: z.string(), username: z.string().optional(), bot: z.boolean().optional() });
export type DiscordMe = z.infer<typeof meSchema>;
const gatewayBotSchema = z.object({ url: z.string(), shards: z.number().int().optional(), session_start_limit: z.object({ remaining: z.number().int(), total: z.number().int(), reset_after: z.number(), max_concurrency: z.number().int() }).optional() });
export type DiscordGatewayBot = z.infer<typeof gatewayBotSchema>;
const messageSchema = z.object({ id: z.string(), channel_id: z.string().optional() });

export interface DiscordClient {
  /** Who a token is: the application's bot user (GET /users/@me). */
  usersMe(token: string): Promise<DiscordMe>;
  /** The wss gateway URL and session budget (GET /gateway/bot). */
  getGatewayBot(token: string): Promise<DiscordGatewayBot>;
  /** Post one message of at most 2000 characters. */
  createMessage(token: string, channelId: string, content: string): Promise<{ id?: string }>;
  /** Show the typing indicator for ~10 seconds. */
  triggerTyping(token: string, channelId: string): Promise<void>;
  /** Splits on the 2000-character limit and sends in order. */
  sendText(token: string, channelId: string, text: string): Promise<number>;
}

export function createDiscordClient(options: { apiBase?: string; fetchImpl?: typeof fetch }): DiscordClient {
  const base = (options.apiBase ?? discordApiBase()).replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  // Tokens travel only in the Authorization header, so failures never carry
  // one in a URL.
  async function call(method: string, path: string, token: string, init?: { body?: Record<string, unknown>; methodOverride?: string }): Promise<unknown> {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method: init?.methodOverride ?? "GET",
        headers: { "content-type": "application/json", authorization: `Bot ${token}` },
        ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new DiscordApiError(method, 0, error instanceof Error ? error.name : "network error");
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      let description = detail.slice(0, 200) || "request refused";
      try { description = JSON.parse(detail)?.message ?? description; } catch { /* keep raw */ }
      throw new DiscordApiError(method, response.status, description);
    }
    if (response.status === 204) return null;
    return response.json().catch(() => null);
  }
  const createMessage = async (token: string, channelId: string, content: string) => {
    const data = await call("createMessage", `/channels/${channelId}/messages`, token, { methodOverride: "POST", body: { content } });
    return messageSchema.parse(data);
  };
  return {
    async usersMe(token) { return meSchema.parse(await call("usersMe", "/users/@me", token)); },
    async getGatewayBot(token) { return gatewayBotSchema.parse(await call("getGatewayBot", "/gateway/bot", token)); },
    createMessage,
    async triggerTyping(token, channelId) {
      await call("triggerTyping", `/channels/${channelId}/typing`, token, { methodOverride: "POST" });
    },
    async sendText(token, channelId, text) {
      const parts = splitDiscordText(text);
      for (const part of parts) await createMessage(token, channelId, part);
      return parts.length;
    },
  };
}

/** Split on paragraph, line, then word boundaries, falling back to a hard
 * cut (never through a surrogate pair). */
export function splitDiscordText(text: string, limit = DISCORD_MAX_MESSAGE_CHARS): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" "));
    if (cut < limit / 2) cut = limit;
    if (cut === limit && /[\uD800-\uDBFF]/.test(window[limit - 1] ?? "")) cut = limit - 1;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest.trim()) parts.push(rest);
  return parts.length ? parts : [text];
}
