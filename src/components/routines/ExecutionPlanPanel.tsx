import { useState } from "react";
import { Loader2 } from "lucide-react";
import { t } from "@/lib/i18n";
import type { Routine } from "@/lib/routines";
import { api, useStore } from "@/state/store";

/** The short label for how a routine runs, or null while it simply runs the bot. */
export function executionBadge(routine: Pick<Routine, "execution" | "reviewing">): string | null {
  if (routine.reviewing) return t("routines.execution.badgeReviewing");
  const plan = routine.execution;
  if (!plan || plan.mode === "llm") return null;
  if (plan.status === "proposed") return t("routines.execution.badgeSuggested");
  return t(plan.mode === "script" ? "routines.execution.badgeScript" : "routines.execution.badgeScriptJev");
}

/** How a saved routine runs: the reviewer's suggestion, its script, and
 * the person's choice. Reads the live routine so a review in flight shows. */
export function ExecutionPlanPanel({ routineId }: { routineId: string }) {
  const { state, dispatch } = useStore();
  const routine = state.routines.find((candidate) => candidate.id === routineId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!routine || routine.target !== "bot") return null;
  const plan = routine.execution;

  const act = async (action: "review" | "approve" | "use-bot") => {
    setBusy(true);
    setError("");
    try {
      const response = await api(`/api/routines/${routine.id}/execution/${action}`, {
        method: "POST",
        body: JSON.stringify(action === "approve" ? { scriptHash: plan?.scriptHash } : {}),
      });
      dispatch({ type: "routinePatched", routine: response.routine });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const summary = routine.reviewing
    ? t("routines.execution.reviewing")
    : !plan
      ? t("routines.execution.none")
      : plan.mode === "llm"
        ? t("routines.execution.llm")
        : t(plan.mode === "script" ? "routines.execution.script" : "routines.execution.scriptJev");
  const button = "rounded-lg border border-hairline/50 px-3 py-1.5 text-[12px] text-ink hover:bg-raised disabled:opacity-40";

  return <section aria-label={t("routines.execution.label")} className="min-w-0 space-y-2 rounded-xl border border-hairline/50 bg-inset px-3.5 py-3">
    <div className="flex items-center gap-2 text-[12px] font-medium text-ink">
      {t("routines.execution.label")}
      {plan?.status === "proposed" && plan.mode !== "llm" && <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] text-accent">{t("routines.execution.needsApproval")}</span>}
    </div>
    <p className="text-[11.5px] leading-relaxed text-ink-secondary">
      {routine.reviewing && <Loader2 size={12} className="mr-1 inline animate-spin" />}
      {summary}
      {plan?.rationale && !routine.reviewing && <> {plan.rationale}</>}
    </p>
    {plan?.mode === "script-jev" && plan.escalateWhen && <p className="text-[11.5px] leading-relaxed text-ink-secondary">{t("routines.execution.escalateWhen", { when: plan.escalateWhen })}</p>}
    {plan?.script && <details open={plan.status === "proposed"}>
      <summary className="cursor-pointer text-[11.5px] text-ink-secondary hover:text-ink">{t("routines.execution.showScript")}</summary>
      <pre className="mt-1.5 max-h-72 overflow-auto rounded-lg bg-panel p-2.5 text-[11px] leading-relaxed text-ink"><code>{plan.script}</code></pre>
    </details>}
    {plan?.status === "proposed" && plan.mode !== "llm" && <p className="text-[11px] leading-relaxed text-ink-secondary">{t("routines.execution.approveHelp")}</p>}
    {error && <p role="alert" className="text-[11.5px] text-danger">{error}</p>}
    <div className="flex flex-wrap gap-2">
      {plan?.status === "proposed" && plan.mode !== "llm" && <button type="button" disabled={busy} onClick={() => void act("approve")} className="rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold text-white hover:brightness-110 disabled:opacity-40">{t("routines.execution.approve")}</button>}
      {plan && plan.mode !== "llm" && <button type="button" disabled={busy} onClick={() => void act("use-bot")} className={button}>{t("routines.execution.useBot")}</button>}
      <button type="button" disabled={busy || routine.reviewing} onClick={() => void act("review")} className={button}>{t(plan ? "routines.execution.reviewAgain" : "routines.execution.review")}</button>
    </div>
  </section>;
}
