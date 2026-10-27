import { PASS, type RouteHandler } from "./table.ts";
import type { createThreadBrowserProfiles } from "../thread-browser-profiles.ts";

export function createThreadBrowserProfileRoutes(deps: {
  profiles: ReturnType<typeof createThreadBrowserProfiles>;
  visible(botId: string, threadId: string, auth: Parameters<RouteHandler>[0]["auth"]): boolean;
}): RouteHandler {
  return async ({ req, res, path, method, url, auth, json, readBody }) => {
    const match = /^\/api\/bots\/([^/]+)\/browser-profile$/.exec(path);
    if (!match) return PASS;
    const botId = match[1]!;
    const threadId = url.searchParams.get("threadId");
    if (!threadId || !deps.visible(botId, threadId, auth)) return json(res, 404, { error: "no such conversation" });
    res.setHeader("cache-control", "no-store");
    try {
      if (method === "GET") return json(res, 200, deps.profiles.state(botId, threadId));
      if (method === "PUT") {
        if ((auth.kind === "session" && !auth.scopes.includes("admin")) || auth.kind === "loopback" && auth.trust === "service") return json(res, 403, { error: "Only an owner or admin may change browser identity." });
        const input = await readBody(req, 4096);
        if (!deps.visible(botId, threadId, auth)) return json(res, 404, { error: "no such conversation" });
        return json(res, 200, deps.profiles.select(botId, threadId, input));
      }
      return json(res, 405, { error: "method not allowed" });
    } catch (error) {
      const status = error instanceof Error && "status" in error && typeof error.status === "number" ? error.status : 500;
      return json(res, status, { error: error instanceof Error ? error.message : "Could not select browser profile." });
    }
  };
}
