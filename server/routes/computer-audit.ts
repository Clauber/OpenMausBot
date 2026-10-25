import { z } from "zod";
import type { ComputerAuditLog } from "../computer-audit.ts";
import type { ComputerEpochs } from "../computer-epoch.ts";
import { SpaceIsolationError, scopeFromHeaders, type ScopeCtx } from "../space-scope.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface ComputerAuditRouteDeps {
  audit: ComputerAuditLog;
  epochs: ComputerEpochs;
  botExists(botId: string): boolean;
  /** The audit key of the computer this bot drives. */
  computerIdFor(botId: string): string;
  /** Throws SpaceIsolationError when a scoped request names a bot outside its space. */
  assertBotInScope?(scope: ScopeCtx, botId: string): void;
}

const outcomes = z.enum(["ok", "denied", "error"]);
const revoke = z.object({ botId: z.string().min(1).max(128), reason: z.string().max(200).optional() }).strict();

/** Audit list and owner revocation for a bot's computer. Admin scope: the log
 * names every tool a bot used, and revocation changes what a bot may do. */
export function createComputerAuditRoutes(deps: ComputerAuditRouteDeps): RouteHandler {
  return async ({ req, res, path, method, url, auth, json, readBody }) => {
    if (path !== "/api/computer-audit" && path !== "/api/computer-audit/revoke") return PASS;
    if (!auth.scopes.includes("admin")) return json(res, 403, { error: "computer audit requires admin scope" });
    res.setHeader("cache-control", "no-store");
    try {
      const scope = scopeFromHeaders(req.headers);
      if (method === "GET" && path === "/api/computer-audit") {
        const botId = url.searchParams.get("botId") ?? "";
        if (!deps.botExists(botId)) return json(res, 404, { error: "no such bot" });
        deps.assertBotInScope?.(scope, botId);
        const outcome = url.searchParams.get("outcome");
        const filterBot = url.searchParams.get("filterBot");
        const action = url.searchParams.get("action");
        const limit = Number(url.searchParams.get("limit") ?? 200);
        const computerId = deps.computerIdFor(botId);
        return json(res, 200, {
          computerId,
          rows: deps.audit.list(computerId, {
            ...(filterBot ? { botId: filterBot } : {}),
            ...(action ? { action } : {}),
            ...(outcome ? { outcome: outcomes.parse(outcome) } : {}),
            limit: Number.isFinite(limit) ? limit : 200,
          }),
        });
      }
      if (method === "POST" && path === "/api/computer-audit/revoke") {
        const body = revoke.parse(await readBody(req));
        if (!deps.botExists(body.botId)) return json(res, 404, { error: "no such bot" });
        deps.assertBotInScope?.(scope, body.botId);
        const reason = body.reason?.trim() || "the owner revoked access";
        const started = Date.now();
        const cancelled = deps.epochs.revoke(body.botId, reason);
        deps.audit.append({
          ts: started, computerId: deps.computerIdFor(body.botId), botId: body.botId, actor: "owner",
          action: "revoke", outcome: "ok", durationMs: Date.now() - started, error: `${reason} (${cancelled} cancelled)`,
        });
        return json(res, 200, { cancelled });
      }
      return json(res, 405, { error: "method not allowed" });
    } catch (error) {
      if (error instanceof SpaceIsolationError) return json(res, 403, error.body());
      if (error instanceof z.ZodError) return json(res, 400, { error: "invalid computer audit input" });
      throw error;
    }
  };
}
