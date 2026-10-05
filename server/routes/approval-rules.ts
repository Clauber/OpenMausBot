import { PASS, type RouteHandler } from "./table.ts";

export interface ApprovalRulesRouteDeps {
  bot(botId: string): { approvalRules?: unknown } | null | undefined;
  workspaceRules(): unknown;
}

/** Read a bot's (and the workspace's) approval rules. Writes go through the bot PATCH handler. */
export function createApprovalRulesRoutes(deps: ApprovalRulesRouteDeps): RouteHandler {
  return async ({ res, path, method, json }) => {
    const m = path.match(/^\/api\/bots\/([\w-]+)\/approval-rules$/);
    if (!m || method !== "GET") return PASS;
    const bot = deps.bot(m[1]);
    if (!bot) return json(res, 404, { error: "no such bot" });
    return json(res, 200, { rules: bot.approvalRules ?? {}, workspace: deps.workspaceRules() });
  };
}
