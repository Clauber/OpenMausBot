// The harness side of the web_fetch and web_search agent tools. The agents
// MCP proxy posts here with its turn capability; the harness fetches, so the
// SSRF guard and the per-bot tool selection live in one place.
import { allowsTool } from "../../shared/tool-scope.ts";
import { webFetch, webSearch } from "../web-tools.ts";
import { WebFetchError } from "../web-ssrf.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface WebToolsRouteDeps {
  /** Resolve the bearer to an active, non-external agents capability. */
  capability(authorization: string | string[] | undefined): { botId: string; threadId: string } | null;
  toolScope(botId: string): unknown;
  searchConfig(): Parameters<typeof webSearch>[1];
  /** A fetch refused because the target looked like a private host. */
  refused(info: { botId: string; threadId: string; host: string; url: string }): void;
}

const TOOLS = { "/api/internal/web-fetch": "web_fetch", "/api/internal/web-search": "web_search" } as const;

export function createWebToolsRoutes(deps: WebToolsRouteDeps): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    const tool = (TOOLS as Record<string, "web_fetch" | "web_search">)[path];
    if (!tool || method !== "POST") return PASS;
    const cap = deps.capability(req.headers.authorization);
    if (!cap) return json(res, 401, { error: "unauthorized" });
    // The same selector the agents MCP gate uses: deny mcp:agents:web_fetch to switch it off for a bot.
    if (!allowsTool(deps.toolScope(cap.botId), { kind: "mcp", server: "agents", name: tool })) {
      return json(res, 403, { error: `${tool} is turned off for this bot in its tool selection.` });
    }
    const body = await readBody(req) as Record<string, unknown>;
    try {
      if (tool === "web_fetch") {
        const url = typeof body.url === "string" ? body.url.trim() : "";
        if (!url) return json(res, 400, { error: "url is required" });
        try {
          return json(res, 200, { ...(await webFetch(url)) });
        } catch (error) {
          if (error instanceof WebFetchError && error.code === "private") {
            deps.refused({ botId: cap.botId, threadId: cap.threadId, host: error.host ?? "", url });
          }
          throw error;
        }
      }
      const query = typeof body.query === "string" ? body.query : "";
      return json(res, 200, { results: await webSearch(query, deps.searchConfig()) });
    } catch (error) {
      const message = error instanceof WebFetchError ? error.message : `${tool} failed: ${(error as Error).message}`;
      return json(res, error instanceof WebFetchError && error.code === "private" ? 403 : 502, { error: message });
    }
  };
}
