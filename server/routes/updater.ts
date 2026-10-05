import { isLoopbackHost, isProxied } from "../request-auth.ts";
import { scopeFromHeaders } from "../space-scope.ts";
import { SelfUpdater, UpdaterError } from "../updater.ts";
import { PASS, type RouteHandler } from "./table.ts";

export function createUpdaterRoutes(updater: SelfUpdater): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (!/^\/api\/updater\/(state|plan|apply)$/.test(path)) return PASS;
    res.setHeader("cache-control", "no-store");
    // Even paired admins cannot replace server code remotely. Reduced loopback
    // service trust and bot/space capabilities cannot grant owner authority.
    if (auth.kind !== "loopback" || auth.trust === "service" || !auth.scopes.includes("admin") || isProxied(req) || !isLoopbackHost(req.socket.remoteAddress) || scopeFromHeaders(req.headers).kind !== "owner") {
      return json(res, 403, { error: "Software updates require the local owner" });
    }
    try {
      if (method === "GET" && path.endsWith("/state")) return json(res, 200, updater.state());
      if (method === "GET" && path.endsWith("/plan")) return json(res, 200, await updater.plan());
      if (method === "POST" && path.endsWith("/apply")) {
        if (!updater.state().enabled) return json(res, 200, { enabled: false });
        const raw = await readBody(req, 4096);
        if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => key !== "target" && key !== "sha256") || ("target" in raw && typeof raw.target !== "string") || ("sha256" in raw && typeof raw.sha256 !== "string")) return json(res, 400, { error: "Invalid update confirmation" });
        const result = await updater.apply(raw as { target?: string; sha256?: string });
        return json(res, result.enabled && result.busy ? 202 : 200, result);
      }
      return json(res, 405, { error: "Method not allowed" });
    } catch (error) {
      return json(res, error instanceof UpdaterError ? error.status : 502, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}
