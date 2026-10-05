import { connectorCallsIn, isOutboundTool } from "../shared/outbound.ts";
import { allowsTool, type ToolIdentity } from "../shared/tool-scope.ts";
import type { ApprovalCategory, ApprovalRules, ApprovalRuleDecision } from "../shared/approval-rules.ts";
export { normalizeApprovalRules } from "../shared/approval-rules.ts";

export function toolIdentity(name: string): ToolIdentity {
  const match = /^mcp__([^_]+(?:_[^_]+)*)__([\s\S]+)$/.exec(name);
  return match ? { kind: "mcp", server: match[1], name: match[2] } : { kind: "native", name };
}

/** Uses outbound's send taxonomy and tool-scope's native/MCP identities.
 * Unknown/opaque tools are writes, never inferred safe reads. */
export function toolCategory(name: string, args?: unknown): ApprovalCategory {
  const identity = toolIdentity(name);
  // These advertised management tools encode deletion in a validated action
  // argument. Keep their exact identity while classifying the actual effect.
  if (identity.kind === "mcp" && identity.server === "agents" && ["propose_routine_action", "skill_manage", "manage_room"].includes(identity.name)
    && args && typeof args === "object" && "action" in args && ["delete", "remove", "remove_bot"].includes(String(args.action))) return "destructive";
  let action = identity.name;
  if ((identity.kind === "native" || identity.server === "composio") && /^[A-Z][A-Z0-9]*_/.test(action)) action = action.slice(action.indexOf("_") + 1);
  const words = action.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  if (["WebFetch", "WebSearch"].includes(name)) return "network";
  if (["GET", "LIST", "FETCH", "SEARCH", "READ", "FIND", "RETRIEVE", "LOOKUP", "DOWNLOAD", "VIEW", "CHECK", "COUNT", "GLOB", "GREP", "LS"].includes(words[0])) return "read";
  if (words.some(word => ["REFUND", "CHARGE", "PAY", "PAYMENT", "PAYOUT", "TRANSFER", "PURCHASE", "BUY"].includes(word))) return "financial";
  if (words.some(word => ["DELETE", "DELETION", "REMOVE", "DESTROY", "DROP", "TRUNCATE", "ERASE", "REVOKE"].includes(word))) return "destructive";
  if (isOutboundTool(name)) return "send-like";
  if (words.some(word => ["HTTP", "REQUEST", "CONNECT", "BROWSE", "NAVIGATE"].includes(word))) return "network";
  return "write";
}

export function approvalCalls(name: string, args: unknown) {
  const identity = toolIdentity(name);
  return connectorCallsIn(identity.kind === "mcp" && identity.server === "composio" ? identity.name : name, args);
}
export function consequentialTool(name: string, args: unknown): boolean {
  return approvalCalls(name, args).some(call => ["send-like", "destructive", "financial"].includes(toolCategory(call.slug, call.arguments)));
}

const INTERNAL_ACTION_TOOLS: Readonly<Record<string, string>> = {
  "/api/internal/bot-deletion-requests": "propose_bot_deletion",
  "/api/internal/team-setup-requests": "propose_team_setup",
  "/api/internal/profile-requests": "propose_profile",
  "/api/internal/model-requests": "propose_model",
  "/api/internal/tightening-requests": "propose_permission_tightening",
  "/api/internal/page-proposals": "propose_page",
  "/api/internal/skills/stage": "skill_manage",
  "/api/internal/post-to-room": "post_to_room",
  "/api/internal/ask-bot": "ask_bot",
  "/api/internal/delegate-bot": "delegate_bot",
  "/api/internal/create-bot": "create_bot",
  "/api/internal/create-room": "create_room",
  "/api/internal/manage-room": "manage_room",
  "/api/internal/memory": "memory_update",
  "/api/internal/memory/log": "memory_log",
  "/api/internal/team-memory": "propose_team_memory",
  "/api/internal/mcp-servers": "add_mcp_server",
  "/api/internal/vm-exec": "vm_exec",
  "/api/internal/voice-note": "send_voice_note",
  "/api/internal/coordinate-bots": "coordinate_bots",
};
export function internalActionTool(path: string, args: any): string | undefined {
  if (path === "/api/internal/routine-requests") return args?.action === "create" ? "propose_routine" : "propose_routine_action";
  if (path === "/api/internal/threads") return args?.oneWay ? "send_to_bot" : "start_thread";
  if (/^\/api\/internal\/threads\/[^/]+\/close$/.test(path)) return "close_thread";
  return INTERNAL_ACTION_TOOLS[path];
}

export interface RuleVerdict { decision: ApprovalRuleDecision | null; rule?: string }
function oneRule(name: string, args: unknown, bot?: ApprovalRules, workspace?: ApprovalRules): RuleVerdict {
  const identity = toolIdentity(name);
  if (["askuserquestion", "ask_user", "omb-ask"].includes(identity.name.toLowerCase())) return { decision: null };
  // Invalid identities cannot acquire a grant. Tool selection still gates dispatch.
  if (!allowsTool(undefined, identity)) return { decision: null };
  const selector = identity.kind === "native" ? `native:${identity.name}` : `mcp:${identity.server}:${identity.name}`;
  const category = toolCategory(name, args);
  for (const [scope, rules] of [["bot", bot], ["workspace", workspace]] as const) {
    for (const tool of [selector, name]) {
      if (rules?.tools && Object.hasOwn(rules.tools, tool)) return { decision: rules.tools[tool], rule: `${scope}:tool:${tool}` };
    }
    if (rules?.categories?.[category]) return { decision: rules.categories[category]!, rule: `${scope}:category:${category}` };
  }
  if (category === "read" && (bot?.readOnlyExempt ?? workspace?.readOnlyExempt ?? true)) return { decision: "always_allow", rule: "read-only-exempt" };
  return { decision: null };
}

export function approvalRule(name: string, args: unknown, bot?: ApprovalRules, workspace?: ApprovalRules): RuleVerdict {
  const outer = oneRule(name, args, bot, workspace);
  const calls = approvalCalls(name, args);
  const verdicts = calls.map(call => oneRule(call.slug, call.arguments, bot, workspace));
  // No outer grant can hide an explicit requirement inside a batch.
  const required = [outer, ...verdicts].find(verdict => verdict.decision === "require_approval");
  if (required) return required;
  if (outer.decision) return outer;
  return verdicts.length && verdicts.every(verdict => verdict.decision === "always_allow") ? verdicts[0] : { decision: null };
}
