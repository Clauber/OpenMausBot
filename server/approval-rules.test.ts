import { describe, expect, it } from "vitest";
import { approvalRule, toolCategory, consequentialTool, internalActionTool } from "./approval-rules.ts";
import { normalizeApprovalRules } from "../shared/approval-rules.ts";

describe("approval rules precedence", () => {
  it.each([
    ["Read", undefined, undefined, "always_allow"],
    ["Write", undefined, undefined, null],
    ["Read", { readOnlyExempt: false }, undefined, null],
    ["Read", { categories: { read: "require_approval" } }, undefined, "require_approval"],
    ["Write", undefined, { categories: { write: "require_approval" } }, "require_approval"],
    ["Write", { categories: { write: "always_allow" } }, { tools: { Write: "require_approval" } }, "always_allow"],
    ["Write", { tools: { "native:Write": "require_approval" }, categories: { write: "always_allow" } }, undefined, "require_approval"],
    ["mcp__mail__send_email", { tools: { "mcp:mail:send_email": "always_allow" } }, undefined, "always_allow"],
  ])("%s evaluates %j over %j to %s", (tool, bot, workspace, expected) => {
    expect(approvalRule(tool, {}, bot as any, workspace as any).decision).toBe(expected);
  });
  it("forces a mixed connector batch to ask if any call requires approval", () => {
    expect(approvalRule("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "GMAIL_SEND_EMAIL" }, { tool_slug: "FILES_DELETE_FILE" }] },
      { categories: { "send-like": "always_allow", destructive: "require_approval" } }).decision).toBe("require_approval");
  });
  it.each([
    ["REDDIT_GET_POST", "read"], ["mcp__stripe__get_payment", "read"], ["mcp__mail__send_email", "send-like"],
    ["STRIPE_REFUND_PAYMENT", "financial"], ["mcp__files__delete_file", "destructive"], ["WebFetch", "network"],
    ["Write", "write"], ["Bash", "write"], ["GMAIL_CREATE_DRAFT", "write"],
  ])("classifies %s as %s", (tool, category) => expect(toolCategory(tool)).toBe(category));
  it("sees rules and consequential actions inside native Composio wrappers", () => {
    const tool = "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL";
    const args = { tools: [{ tool_slug: "GMAIL_SEND_EMAIL" }] };
    expect(consequentialTool(tool, args)).toBe(true);
    expect(approvalRule(tool, args, { tools: { GMAIL_SEND_EMAIL: "require_approval" } }).decision).toBe("require_approval");
  });
  it("never grants a human question through an action rule", () => {
    expect(approvalRule("mcp__ogb__ask_user", {}, { tools: { "mcp:ogb:ask_user": "always_allow" } }).decision).toBeNull();
  });
  it("sees consequential actions inside batches", () => {
    expect(consequentialTool("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "GMAIL_SEND_EMAIL" }] })).toBe(true);
    expect(consequentialTool("GMAIL_GET_MESSAGE", {})).toBe(false);
  });
  it("maps internal routes to the advertised identities and preserves destructive routine semantics", () => {
    const tool = internalActionTool("/api/internal/routine-requests", { action: "delete" })!;
    expect(tool).toBe("propose_routine_action");
    expect(internalActionTool("/api/internal/routine-requests", { action: "create" })).toBe("propose_routine");
    expect(internalActionTool("/api/internal/skills/stage", {})).toBe("skill_manage");
    expect(approvalRule(`mcp__agents__${tool}`, { action: "delete" }, { tools: { "mcp:agents:propose_routine_action": "require_approval" } }).decision).toBe("require_approval");
    expect(approvalRule(`mcp__agents__${tool}`, { action: "delete" }, { categories: { destructive: "require_approval" } }).decision).toBe("require_approval");
    expect(consequentialTool(`mcp__agents__${tool}`, { action: "delete" })).toBe(true);
  });
  it("rejects invalid and oversized settings", () => {
    expect(normalizeApprovalRules({ tools: { Bash: "allow" } })).toBeNull();
    expect(normalizeApprovalRules({ categories: { imaginary: "always_allow" } })).toBeNull();
    expect(normalizeApprovalRules({ readOnlyExempt: "yes" })).toBeNull();
    expect(normalizeApprovalRules({ unknown: true })).toBeNull();
    expect(normalizeApprovalRules({ tools: { "native:*": "always_allow" } })).toBeNull();
    expect(normalizeApprovalRules({ tools: { "mcp:mail:send_email": "always_allow" } })).toEqual({ tools: { "mcp:mail:send_email": "always_allow" } });
  });
});
