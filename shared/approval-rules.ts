/** Installation-local action rules. Exact tools override category defaults. */
export const APPROVAL_CATEGORIES = ["read", "write", "network", "send-like", "destructive", "financial"] as const;
export type ApprovalCategory = typeof APPROVAL_CATEGORIES[number];
export type ApprovalRuleDecision = "always_allow" | "require_approval";
export interface ApprovalRules {
  tools?: Record<string, ApprovalRuleDecision>;
  categories?: Partial<Record<ApprovalCategory, ApprovalRuleDecision>>;
  readOnlyExempt?: boolean;
}

export function normalizeApprovalRules(value: unknown): ApprovalRules | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !["tools", "categories", "readOnlyExempt"].includes(key))) return null;
  if (raw.readOnlyExempt !== undefined && typeof raw.readOnlyExempt !== "boolean") return null;
  const result: ApprovalRules = {};
  if (raw.readOnlyExempt !== undefined) result.readOnlyExempt = raw.readOnlyExempt as boolean;
  for (const key of ["tools", "categories"] as const) {
    if (raw[key] === undefined) continue;
    const map = raw[key];
    if (!map || typeof map !== "object" || Array.isArray(map) || Object.keys(map).length > 256) return null;
    const entries: Record<string, ApprovalRuleDecision> = {};
    for (const [selector, decision] of Object.entries(map)) {
      if (decision !== "always_allow" && decision !== "require_approval") return null;
      if (key === "categories" && !APPROVAL_CATEGORIES.includes(selector as ApprovalCategory)) return null;
      if (key === "tools" && (!selector.trim() || selector !== selector.trim() || selector.length > 1024 || /[\s*]/.test(selector)
        || !/^[a-zA-Z0-9_:./-]+$/.test(selector))) return null;
      entries[selector] = decision;
    }
    result[key] = entries;
  }
  return result;
}
