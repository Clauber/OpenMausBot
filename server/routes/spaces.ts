import { z } from "zod";
import { SPACE_KINDS, SpaceError, SpaceIsolationError, scopeFromHeaders, type SpaceEntityKind, type SpaceRegistry } from "../space-scope.ts";
import type { ServerResponse } from "node:http";
import { PASS, type RouteHandler } from "./table.ts";

export interface SpacesRouteDeps {
  registry: SpaceRegistry;
  /** Whether an entity of this kind exists, so a typo cannot park an id in a space. */
  exists(kind: SpaceEntityKind, id: string): boolean;
  onChange?(): void;
  /** Rewrites the JSON body this response is about to send (harness/http.ts onJsonBody). */
  onJsonBody(res: ServerResponse, rewrite: (body: unknown) => unknown): void;
}

const name = z.object({ name: z.string() }).strict();
const assign = z.object({ kind: z.enum(SPACE_KINDS), id: z.string().min(1).max(128), spaceId: z.string().min(1).max(128) }).strict();
const pair = z.object({ from: z.string().min(1).max(128), to: z.string().min(1).max(128) }).strict();

/** Space administration: owner/admin only, and never from a space-scoped context. */
export function createSpacesRoutes(deps: SpacesRouteDeps): RouteHandler {
  const { registry } = deps;
  const snapshot = () => ({ spaces: registry.list(), assignments: registry.assignments(), allowlist: registry.allowlist() });
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (method === "GET" && path === "/api/bots") {
      // A space-scoped context lists only its own space's bots, and no groups.
      const scope = scopeFromHeaders(req.headers);
      if (scope.kind === "space") deps.onJsonBody(res, (body) => {
        if (!body || typeof body !== "object") return body;
        const record = body as { bots?: Array<{ id: string }>; groups?: unknown[]; computerControl?: Record<string, unknown> };
        const mine = (record.bots ?? []).filter((bot) => registry.spaceOf("bot", bot.id) === scope.spaceId);
        const ids = new Set(mine.map((bot) => bot.id));
        return { ...record, bots: mine, groups: [], computerControl: Object.fromEntries(Object.entries(record.computerControl ?? {}).filter(([id]) => ids.has(id))) };
      });
      return PASS;
    }
    if (path !== "/api/spaces" && !path.startsWith("/api/spaces/")) return PASS;
    res.setHeader("cache-control", "no-store");
    try {
      const scope = scopeFromHeaders(req.headers);
      if (method === "GET" && path === "/api/spaces") {
        // A scoped context learns only its own space.
        const all = snapshot();
        if (scope.kind === "owner") return json(res, 200, all);
        return json(res, 200, { spaces: all.spaces.filter((space) => space.id === scope.spaceId), assignments: {}, allowlist: [] });
      }
      if (scope.kind !== "owner") throw new SpaceIsolationError(scope.spaceId, "Spaces are managed from outside any space");
      if (!auth.scopes.includes("admin")) return json(res, 403, { error: "spaces require admin scope" });
      const changed = <T>(result: T) => { deps.onChange?.(); return result; };
      if (method === "POST" && path === "/api/spaces") return json(res, 201, changed({ space: registry.create(name.parse(await readBody(req)).name), ...snapshot() }));
      if (method === "PUT" && path === "/api/spaces/assign") {
        const body = assign.parse(await readBody(req));
        if (!deps.exists(body.kind, body.id)) throw new SpaceError(`no such ${body.kind}`, 404);
        registry.assign(body.kind, body.id, body.spaceId);
        return json(res, 200, changed(snapshot()));
      }
      if (path === "/api/spaces/allowlist" && (method === "POST" || method === "DELETE")) {
        const body = pair.parse(await readBody(req));
        if (method === "POST") registry.allowDelegation(body.from, body.to); else registry.revokeDelegation(body.from, body.to);
        return json(res, 200, changed(snapshot()));
      }
      const match = path.match(/^\/api\/spaces\/([\w.-]+)$/);
      if (match && method === "PATCH") return json(res, 200, changed({ space: registry.rename(match[1]!, name.parse(await readBody(req)).name) }));
      if (match && method === "DELETE") { registry.delete(match[1]!); return json(res, 200, changed({ ok: true })); }
      return json(res, 404, { error: "space route not found" });
    } catch (error) {
      if (error instanceof SpaceIsolationError) return json(res, 403, error.body());
      if (error instanceof SpaceError) return json(res, error.status, { error: error.message, code: "space_error" });
      if (error instanceof z.ZodError) return json(res, 400, { error: "invalid space input", code: "validation_error" });
      throw error;
    }
  };
}
