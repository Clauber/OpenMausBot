// /api/messaging/discord: bindings between a bot and a Discord application's
// bot, and the pairing codes that let a DM join one. Inbound events arrive
// over the gateway (one outbound WebSocket per binding), so no public URL is
// ever needed. Admin-scoped by default in server/request-auth.ts (a new route
// is admin-only until listed there), so a member session never reaches it.
// The token is accepted and used, never returned after creation.
import { z } from "zod";

import type { DiscordBinding, DiscordBindingStore } from "../messaging/discord-store.ts";
import { createDiscordClient, type DiscordClient } from "../messaging/discord.ts";
import { PASS, type RouteHandler } from "./table.ts";

/** The slice of DiscordService the routes drive: gateway lifecycle and live
 * status. An interface, so routes never import the service module. */
export interface DiscordSocketControl {
  startSocket(bindingId: string): void;
  stopSocket(bindingId: string): void;
  socketState(bindingId: string): { status: string; error?: string; at: number } | undefined;
}

export interface DiscordRouteDeps {
  store: DiscordBindingStore;
  /** True when the bot exists. */
  botExists(botId: string): boolean;
  /** The running service, when the gateway is wired up (tests may omit it). */
  socket?: DiscordSocketControl;
  clientFor?(token: string): DiscordClient;
}

const createSchema = z.object({
  botId: z.string().regex(/^[\w-]+$/),
  token: z.string().min(30, "paste the bot token from the Discord developer portal"),
}).strict();
const enabledSchema = z.object({ enabled: z.boolean() }).strict();

function view(binding: DiscordBinding, deps: DiscordRouteDeps) {
  return {
    id: binding.id,
    botId: binding.botId,
    botMissing: !deps.botExists(binding.botId),
    userId: binding.userId ?? null,
    username: binding.username ?? null,
    createdAt: binding.createdAt,
    socket: deps.socket?.socketState(binding.id) ?? null,
    pairing: binding.pairing && binding.pairing.expiresAt > Date.now() ? { expiresAt: binding.pairing.expiresAt } : null,
    chats: Object.entries(binding.chats).map(([channelId, chat]) => ({ channelId, ...chat })),
  };
}

export function createDiscordRoutes(deps: DiscordRouteDeps): RouteHandler {
  const clientFor = deps.clientFor ?? (() => createDiscordClient({}));
  const failure = (error: unknown, token: string) => (error instanceof Error ? error.message : "failed").split(token).join("<token>");
  return async ({ req, res, path, method, json, readBody }) => {
    const m = path.match(/^\/api\/messaging\/discord(?:\/(dc_[A-Za-z0-9_-]+)(?:\/(pairing|chats\/(\d{5,25})))?)?$/);
    if (!m) return PASS;
    res.setHeader("cache-control", "no-store");
    const [, id, sub, channelId] = m;

    if (!id) {
      if (method === "GET") return json(res, 200, { bindings: deps.store.list().map((b) => view(b, deps)) });
      if (method !== "POST") return PASS;
      const parsed = createSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: parsed.error.issues[0]?.message ?? "botId and token required" });
      const input = parsed.data;
      if (!deps.botExists(input.botId)) return json(res, 404, { error: "no such bot" });
      let me: Awaited<ReturnType<DiscordClient["usersMe"]>>;
      try { me = await clientFor(input.token).usersMe(input.token); }
      catch (error) { return json(res, 400, { error: `Discord rejected that token: ${failure(error, input.token)}` }); }
      const binding = deps.store.create({ botId: input.botId, token: input.token, userId: me.id, username: me.username });
      // Prove the gateway works now (the URL is thrown away) rather than
      // fail silently forever after.
      try { await clientFor(input.token).getGatewayBot(input.token); }
      catch (error) {
        deps.store.remove(binding.id);
        return json(res, 400, { error: `Discord refused the gateway for that token: ${failure(error, input.token)}` });
      }
      deps.socket?.startSocket(binding.id);
      return json(res, 201, { binding: view(binding, deps) });
    }

    const binding = deps.store.get(id);
    if (!binding) return json(res, 404, { error: "no such Discord binding" });
    if (!sub) {
      if (method === "GET") return json(res, 200, { binding: view(binding, deps) });
      if (method !== "DELETE") return PASS;
      // Best effort: the binding goes either way, so a dead token cannot pin it.
      deps.socket?.stopSocket(id);
      deps.store.remove(id);
      return json(res, 200, { ok: true });
    }
    if (sub === "pairing" && method === "POST") {
      const pairing = deps.store.startPairing(id)!;
      return json(res, 201, { ...pairing, username: binding.username ?? null });
    }
    if (channelId) {
      if (method === "DELETE") {
        return deps.store.removeChat(id, channelId) ? json(res, 200, { ok: true }) : json(res, 404, { error: "no such conversation" });
      }
      if (method === "PATCH") {
        const parsed = enabledSchema.safeParse(await readBody(req));
        if (!parsed.success) return json(res, 400, { error: "enabled must be true or false" });
        return deps.store.setChatEnabled(id, channelId, parsed.data.enabled) ? json(res, 200, { ok: true }) : json(res, 404, { error: "no such conversation" });
      }
    }
    return PASS;
  };
}
