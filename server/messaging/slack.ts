// Slack Web API + Socket Mode client. Only the calls the adapter needs, over
// fetch and the platform WebSocket, with the API base overridable
// (SLACK_API_BASE) so tests and the isolated fixture talk to
// server/testing/fake-slack.ts instead of Slack. Protocol references pulled
// 2026-10-10: docs.slack.dev/apis/events-api/using-socket-mode.md,
// docs.slack.dev/reference/methods/{apps.connections.open,chat.postmessage,auth.test}.md.
import { z } from "zod";

export const DEFAULT_SLACK_API_BASE = "https://slack.com/api";
/** Slack truncates chat.postMessage text over 40,000 characters; replies are
 * sent whole and this is documented as the platform ceiling. */
export const SLACK_MAX_MESSAGE_CHARS = 40_000;

export function slackApiBase(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.SLACK_API_BASE?.trim();
  return (raw || DEFAULT_SLACK_API_BASE).replace(/\/+$/, "");
}

export class SlackApiError extends Error {
  readonly status: number;
  /** Slack's error code inside `{ok: false, error}` ("invalid_auth", ...). */
  readonly code: string;
  constructor(method: string, status: number, code: string) {
    super(`Slack ${method} failed (${status}): ${code}`);
    this.status = status;
    this.code = code;
  }
}

/** The socket ended because we closed it (stop, unbind) — not an error, the
 * loop just exits. */
export class SlackSocketClosed extends Error {
  constructor() { super("Slack socket closed by request"); }
}

const envelopeSchema = z.object({ ok: z.boolean(), error: z.string().optional() });
const authTestSchema = z.object({
  ok: z.boolean(),
  team_id: z.string().optional(),
  team: z.string().optional(),
  user_id: z.string(),
  user: z.string().optional(),
  bot_id: z.string().optional(),
});
export type SlackAuthTest = z.infer<typeof authTestSchema>;
const postMessageSchema = z.object({ ok: z.boolean(), channel: z.string().optional(), ts: z.string().optional() });

export interface SlackClient {
  /** Who a token is: team, user id (the bot user for xoxb tokens), bot id. */
  authTest(token: string): Promise<SlackAuthTest>;
  /** Post one message. `threadTs` makes it a threaded reply. */
  postMessage(token: string, channel: string, text: string, threadTs?: string): Promise<{ ts?: string }>;
  /** One temporary wss:// URL for the Socket Mode connection. Requires the
   * app-level token (xapp-…) in the Authorization header. */
  connectionsOpen(appToken: string): Promise<string>;
}

export function createSlackClient(options: { apiBase?: string; fetchImpl?: typeof fetch }): SlackClient {
  const base = (options.apiBase ?? slackApiBase()).replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  // Slack answers are `{ok: true, ...}` or `{ok: false, error}`; tokens travel
  // in the Authorization header (apps.connections.open refuses them as POST
  // parameters), so failures never carry the token in a URL.
  async function call<T>(method: string, token: string, body: Record<string, unknown>, parse: (data: Record<string, unknown>) => T): Promise<T> {
    let response: Response;
    try {
      response = await doFetch(`${base}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new SlackApiError(method, 0, error instanceof Error ? error.name : "network error");
    }
    // Only ok/error is read here; the raw object moves on, because a zod
    // object schema would strip the fields the caller's parse still needs.
    const raw: unknown = await response.json().catch(() => null);
    const checked = envelopeSchema.safeParse(raw);
    if (!checked.success || !checked.data.ok) {
      throw new SlackApiError(method, response.status, checked.success ? checked.data.error ?? "request refused" : "unreadable response");
    }
    return parse(raw as Record<string, unknown>);
  }
  return {
    async authTest(token) {
      const data = await call("auth.test", token, {}, (d) => authTestSchema.parse(d));
      return data;
    },
    async postMessage(token, channel, text, threadTs) {
      const data = await call("chat.postMessage", token, { channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) }, (d) => postMessageSchema.parse(d));
      return { ts: data.ts };
    },
    async connectionsOpen(appToken) {
      const data = await call("apps.connections.open", appToken, {}, (d) => z.object({ url: z.string() }).parse(d));
      return data.url;
    },
  };
}
