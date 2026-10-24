// /api/messaging/slack: bindings between a bot and a Slack app, and the
// pairing codes that let a DM join one. Inbound events arrive over Socket Mode
// (apps.connections.open → one outbound WebSocket per binding), so no public
// URL is ever needed. Admin-scoped by default in server/request-auth.ts (a new
// route is admin-only until listed there), so a member session never reaches
// it. Both tokens are accepted and used, never returned after creation.
import { z } from "zod";

import type { SlackBinding, SlackBindingStore } from "../messaging/slack-store.ts";
import { createSlackClient, type SlackClient } from "../messaging/slack.ts";
import { PASS, type RouteHandler } from "./table.ts";

/** The slice of SlackService the routes drive: socket lifecycle and live
 * status. An interface, so routes never import the service module. */
export interface SlackSocketControl {
  startSocket(bindingId: string): void;
  stopSocket(bindingId: string): void;
  socketState(bindingId: string): { status: string; error?: string; at: number } | undefined;
}

export interface SlackRouteDeps {
  store: SlackBindingStore;
  /** True when the bot exists. */
  botExists(botId: string): boolean;
  /** The running service, when Socket Mode is wired up (tests may omit it). */
  socket?: SlackSocketControl;
  clientFor?(tokens: { appToken: string; botToken: string }): SlackClient;
}

const createSchema = z.object({
  botId: z.string().regex(/^[\w-]+$/),
  /** App-level token (xapp-…) with connections:write, for Socket Mode. */
  appToken: z.string().regex(/^xapp-\S{20,}$/, "app token looks like xapp-1-..."),
  /** Bot token (xoxb-…) with chat:write + im:history. */
  botToken: z.string().regex(/^xoxb-\S{20,}$/, "bot token looks like xoxb-..."),
}).strict();
const enabledSchema = z.object({ enabled: z.boolean() }).strict();

function view(binding: SlackBinding, deps: SlackRouteDeps) {
  return {
    id: binding.id,
    botId: binding.botId,
    botMissing: !deps.botExists(binding.botId),
    teamId: binding.teamId ?? null,
    teamName: binding.teamName ?? null,
    botUserId: binding.botUserId ?? null,
    botName: binding.botName ?? null,
    createdAt: binding.createdAt,
    socket: deps.socket?.socketState(binding.id) ?? null,
    pairing: binding.pairing && binding.pairing.expiresAt > Date.now() ? { expiresAt: binding.pairing.expiresAt } : null,
    chats: Object.entries(binding.chats).map(([channelId, chat]) => ({ channelId, ...chat })),
  };
}

export function createSlackRoutes(deps: SlackRouteDeps): RouteHandler {
  const clientFor = deps.clientFor ?? (() => createSlackClient({}));
  const failure = (error: unknown, ...tokens: string[]) => {
    let message = error instanceof Error ? error.message : "failed";
    for (const token of tokens) message = message.split(token).join("<token>");
    return message;
  };
  return async ({ req, res, path, method, json, readBody }) => {
    const m = path.match(/^\/api\/messaging\/slack(?:\/(sl_[A-Za-z0-9_-]+)(?:\/(pairing|chats\/([CDGF][A-Za-z0-9]+)))?)?$/);
    if (!m) return PASS;
    res.setHeader("cache-control", "no-store");
    const [, id, sub, channelId] = m;

    if (!id) {
      if (method === "GET") return json(res, 200, { bindings: deps.store.list().map((b) => view(b, deps)) });
      if (method !== "POST") return PASS;
      const parsed = createSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: parsed.error.issues[0]?.message ?? "botId, appToken and botToken required" });
      const input = parsed.data;
      if (!deps.botExists(input.botId)) return json(res, 404, { error: "no such bot" });
      let auth: Awaited<ReturnType<SlackClient["authTest"]>>;
      try { auth = await clientFor(input).authTest(input.botToken); }
      catch (error) { return json(res, 400, { error: `Slack rejected that bot token: ${failure(error, input.botToken, input.appToken)}` }); }
      const binding = deps.store.create({
        botId: input.botId, appToken: input.appToken, botToken: input.botToken,
        ...(auth.team_id ? { teamId: auth.team_id } : {}), ...(auth.team ? { teamName: auth.team } : {}),
        botUserId: auth.user_id, ...(auth.user ? { botName: auth.user } : {}),
      });
      // The app-level token earns its keep only if Socket Mode works; verify
      // now (the URL is thrown away) rather than fail silently forever after.
      try { await clientFor(input).connectionsOpen(input.appToken); }
      catch (error) {
        deps.store.remove(binding.id);
        return json(res, 400, { error: `Slack refused Socket Mode for that app token: ${failure(error, input.botToken, input.appToken)}` });
      }
      deps.socket?.startSocket(binding.id);
      return json(res, 201, { binding: view(binding, deps) });
    }

    const binding = deps.store.get(id);
    if (!binding) return json(res, 404, { error: "no such Slack binding" });
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
      return json(res, 201, { ...pairing, teamName: binding.teamName ?? null });
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
