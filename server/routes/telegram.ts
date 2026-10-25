// /api/messaging/telegram: bindings between a bot and a Telegram bot, and the
// pairing codes that let a chat join one. Inbound updates arrive by getUpdates
// long-polling by default (no public URL needed); a binding may switch to
// webhook delivery with a public https URL instead. Admin-scoped by default in
// server/request-auth.ts (a new route is admin-only until listed there), so a
// member session never reaches it. Tokens and secrets are accepted and used,
// never returned after creation (the secret is shown once, with the webhook URL).
import { z } from "zod";

import type { TelegramBinding, TelegramBindingStore } from "../messaging/telegram-store.ts";
import { createTelegramClient, type TelegramClient } from "../messaging/telegram.ts";
import { PASS, type RouteHandler } from "./table.ts";

/** The slice of TelegramService the routes drive: poller lifecycle and live
 * status. An interface, so routes never import the service module. */
export interface TelegramPollControl {
  startPolling(bindingId: string): void;
  stopPolling(bindingId: string): void;
  pollerState(bindingId: string): { status: string; error?: string; at: number } | undefined;
}

export interface TelegramRouteDeps {
  store: TelegramBindingStore;
  /** True when the bot exists. */
  botExists(botId: string): boolean;
  /** Where Telegram should call: the advertised webhook receiver base. */
  webhookBase(): string;
  /** The running service, when poll delivery is wired up (tests may omit it). */
  poll?: TelegramPollControl;
  clientFor?(binding: Pick<TelegramBinding, "token">): TelegramClient;
}

const createSchema = z.object({
  botId: z.string().regex(/^[\w-]+$/),
  token: z.string().regex(/^\d+:[A-Za-z0-9_-]{20,}$/, "token looks like 123456:ABC-..."),
  markdown: z.boolean().optional(),
  /** Deliver by webhook at this public https URL instead of the default
   * getUpdates polling. */
  publicBaseUrl: z.string().url().optional(),
}).strict();
const webhookSchema = z.object({ publicBaseUrl: z.string().url().optional() }).strict();
const enabledSchema = z.object({ enabled: z.boolean() }).strict();

function view(binding: TelegramBinding, deps: TelegramRouteDeps) {
  const transport = binding.transport ?? "poll";
  return {
    id: binding.id,
    botId: binding.botId,
    botMissing: !deps.botExists(binding.botId),
    username: binding.username ?? null,
    markdown: binding.markdown === true,
    createdAt: binding.createdAt,
    transport,
    poller: transport === "poll" ? deps.poll?.pollerState(binding.id) ?? null : null,
    pollOffset: binding.pollOffset ?? null,
    webhookPath: `/hooks/telegram/${binding.id}`,
    pairing: binding.pairing && binding.pairing.expiresAt > Date.now() ? { expiresAt: binding.pairing.expiresAt } : null,
    chats: Object.entries(binding.chats).map(([chatId, chat]) => ({ chatId, ...chat })),
  };
}

export function createTelegramRoutes(deps: TelegramRouteDeps): RouteHandler {
  const clientFor = deps.clientFor ?? ((binding) => createTelegramClient({ token: binding.token }));
  const hookUrl = (id: string, base?: string) => `${(base ?? deps.webhookBase()).replace(/\/+$/, "")}/hooks/telegram/${id}`;
  const failure = (error: unknown, token: string) => (error instanceof Error ? error.message : "failed").split(token).join("<token>");
  return async ({ req, res, path, method, json, readBody }) => {
    const m = path.match(/^\/api\/messaging\/telegram(?:\/(tg_[A-Za-z0-9_-]+)(?:\/(pairing|webhook|poll|chats\/(-?\d+)))?)?$/);
    if (!m) return PASS;
    res.setHeader("cache-control", "no-store");
    const [, id, sub, chatId] = m;

    if (!id) {
      if (method === "GET") return json(res, 200, { bindings: deps.store.list().map((b) => view(b, deps)) });
      if (method !== "POST") return PASS;
      const parsed = createSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: parsed.error.issues[0]?.message ?? "botId and token required" });
      const input = parsed.data;
      if (!deps.botExists(input.botId)) return json(res, 404, { error: "no such bot" });
      let me;
      try { me = await clientFor({ token: input.token }).getMe(); }
      catch (error) { return json(res, 400, { error: `Telegram rejected that token: ${failure(error, input.token)}` }); }
      const binding = deps.store.create({ botId: input.botId, token: input.token, username: me.username, markdown: input.markdown, transport: input.publicBaseUrl ? "webhook" : "poll" });
      let webhook: { registered: boolean; error?: string } = { registered: false };
      if (input.publicBaseUrl) {
        try { await clientFor(binding).setWebhook(hookUrl(binding.id, input.publicBaseUrl), binding.secret); webhook = { registered: true }; }
        catch (error) {
          // Webhook delivery is the point of this create; say so instead of
          // silently falling back to polling behind the operator's back.
          deps.store.remove(binding.id);
          return json(res, 502, { error: `Telegram refused that webhook URL: ${failure(error, binding.token)}` });
        }
      } else {
        deps.poll?.startPolling(binding.id);
      }
      return json(res, 201, { binding: view(binding, deps), webhookUrl: hookUrl(binding.id, input.publicBaseUrl), secret: binding.secret, webhook });
    }

    const binding = deps.store.get(id);
    if (!binding) return json(res, 404, { error: "no such Telegram binding" });
    if (!sub) {
      if (method === "GET") return json(res, 200, { binding: view(binding, deps) });
      if (method !== "DELETE") return PASS;
      // Best effort: the binding goes either way, so a dead token cannot pin it.
      deps.poll?.stopPolling(id);
      await clientFor(binding).deleteWebhook().catch(() => undefined);
      deps.store.remove(id);
      return json(res, 200, { ok: true });
    }
    if (sub === "pairing" && method === "POST") {
      const pairing = deps.store.startPairing(id)!;
      return json(res, 201, { ...pairing, username: binding.username ?? null });
    }
    if (sub === "poll") {
      if (method === "GET") {
        const transport = binding.transport ?? "poll";
        return json(res, 200, { transport, poller: transport === "poll" ? deps.poll?.pollerState(id) ?? null : null });
      }
      if (method === "POST") {
        deps.store.setTransport(id, "poll");
        deps.poll?.startPolling(id);
        return json(res, 200, { ok: true, transport: "poll", poller: deps.poll?.pollerState(id) ?? null });
      }
    }
    if (sub === "webhook") {
      if (method === "GET") {
        try { return json(res, 200, { webhook: await clientFor(binding).getWebhookInfo(), expectedPath: `/hooks/telegram/${id}` }); }
        catch (error) { return json(res, 502, { error: failure(error, binding.token) }); }
      }
      if (method === "POST") {
        const parsed = webhookSchema.safeParse(await readBody(req));
        if (!parsed.success) return json(res, 400, { error: "publicBaseUrl must be a URL" });
        try { await clientFor(binding).setWebhook(hookUrl(id, parsed.data.publicBaseUrl), binding.secret); }
        catch (error) { return json(res, 502, { error: failure(error, binding.token) }); }
        // Webhook delivery replaces the poller (Bot API: one or the other).
        deps.store.setTransport(id, "webhook");
        deps.poll?.stopPolling(id);
        return json(res, 200, { ok: true, webhookUrl: hookUrl(id, parsed.data.publicBaseUrl) });
      }
      if (method === "DELETE") {
        try { await clientFor(binding).deleteWebhook(); }
        catch (error) { return json(res, 502, { error: failure(error, binding.token) }); }
        deps.store.setTransport(id, "poll");
        deps.poll?.startPolling(id);
        return json(res, 200, { ok: true, transport: "poll" });
      }
    }
    if (chatId) {
      if (method === "DELETE") {
        return deps.store.removeChat(id, chatId) ? json(res, 200, { ok: true }) : json(res, 404, { error: "no such chat" });
      }
      if (method === "PATCH") {
        const parsed = enabledSchema.safeParse(await readBody(req));
        if (!parsed.success) return json(res, 400, { error: "enabled must be true or false" });
        return deps.store.setChatEnabled(id, chatId, parsed.data.enabled) ? json(res, 200, { ok: true }) : json(res, 404, { error: "no such chat" });
      }
    }
    return PASS;
  };
}
