import { useEffect, useRef, useState } from "react";
import type { Bot } from "@/state/store";
import { APPROVAL_CATEGORIES, normalizeApprovalRules, type ApprovalRuleDecision, type ApprovalRules } from "../../../shared/approval-rules";
import { useBotEditor } from "./BotEditorContext";
import { inputCls } from "./field";

const lines = (text: string) => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

export function ApprovalRulesCard({ bot }: { bot: Bot }) {
  const { request } = useBotEditor();
  const [rules, setRules] = useState<ApprovalRules>(bot.approvalRules ?? {});
  const [allow, setAllow] = useState(Object.entries(bot.approvalRules?.tools ?? {}).filter(([, value]) => value === "always_allow").map(([key]) => key).join("\n"));
  const [ask, setAsk] = useState(Object.entries(bot.approvalRules?.tools ?? {}).filter(([, value]) => value === "require_approval").map(([key]) => key).join("\n"));
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const save = async () => {
    if (saving) return;
    if (lines(allow).some(tool => lines(ask).includes(tool))) { setStatus("A tool cannot be in both lists."); return; }
    const tools = Object.fromEntries([...lines(allow).map(tool => [tool, "always_allow"]), ...lines(ask).map(tool => [tool, "require_approval"])]);
    const normalized = normalizeApprovalRules({ ...rules, tools });
    if (!normalized) { setStatus("Use exact tool names or native:Tool / mcp:server:tool selectors, without wildcards."); return; }
    setSaving(true); setStatus("");
    try {
      await request(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ approvalRules: normalized }) });
      if (alive.current) setStatus("Approval rules saved.");
    } catch (cause) {
      if (alive.current) setStatus(cause instanceof Error ? cause.message : String(cause));
    } finally { if (alive.current) setSaving(false); }
  };
  return <div className="rounded-xl bg-card p-4">
    <div className="text-[15px] font-medium text-ink">Approval rules</div>
    <p className="mt-0.5 text-[13px] text-ink-secondary">Choose which actions always need your confirmation. Exact tool rules take priority over categories. Inherit uses workspace defaults and the approval level. Send allowances still apply.</p>
    <label className="mt-3 flex items-center justify-between gap-3 text-[13px] text-ink-secondary">
      Read-only exemption
      <select aria-label="Read-only exemption" className={inputCls} value={rules.readOnlyExempt === undefined ? "inherit" : String(rules.readOnlyExempt)} onChange={event => {
        const { readOnlyExempt: _old, ...rest } = rules;
        setRules({ ...rest, ...(event.target.value === "inherit" ? {} : { readOnlyExempt: event.target.value === "true" }) }); setStatus("");
      }}>
        <option value="inherit">Inherit (default: exempt)</option><option value="true">Exempt reads</option><option value="false">Use approval level</option>
      </select>
    </label>
    <div className="mt-3 grid gap-2">
      {APPROVAL_CATEGORIES.map(category => <label key={category} className="flex items-center justify-between gap-2 text-[13px] text-ink-secondary">
        {category}
        <select aria-label={`Approval rule for ${category}`} className={inputCls.replace("w-full", "w-48 shrink-0")} value={rules.categories?.[category] ?? "inherit"} onChange={event => {
          const categories = { ...rules.categories };
          if (event.target.value === "inherit") delete categories[category]; else categories[category] = event.target.value as ApprovalRuleDecision;
          setRules({ ...rules, categories }); setStatus("");
        }}><option value="inherit">Inherit</option><option value="always_allow">Always allow</option><option value="require_approval">Require approval</option></select>
      </label>)}
    </div>
    <p className="mt-3 text-[12px] text-ink-secondary">One exact tool per line, for example native:Write or mcp:mail:send_email.</p>
    <div className="mt-2 grid gap-3 sm:grid-cols-2">
      <label className="text-[13px] text-ink-secondary">Always allow tools<textarea aria-label="Always allow tools" className={inputCls + " mt-1 min-h-20 w-full font-mono"} value={allow} onChange={event => { setAllow(event.target.value); setStatus(""); }} /></label>
      <label className="text-[13px] text-ink-secondary">Require approval tools<textarea aria-label="Require approval tools" className={inputCls + " mt-1 min-h-20 w-full font-mono"} value={ask} onChange={event => { setAsk(event.target.value); setStatus(""); }} /></label>
    </div>
    <button type="button" disabled={saving} onClick={() => void save()} className="mt-3 text-[13px] text-accent hover:underline disabled:opacity-40">{saving ? "Saving approval rules…" : "Save approval rules"}</button>
    {status && <p role="status" className="mt-2 text-[12px] text-ink-secondary">{status}</p>}
  </div>;
}
