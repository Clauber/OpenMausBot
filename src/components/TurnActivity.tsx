import { useEffect, useId, useState } from "react";
import { Check, ChevronRight, CircleAlert } from "lucide-react";
import type { ChatTurnActivity } from "@/lib/chat-turn-activity";
import { t } from "@/lib/i18n";
import { formatDuration } from "@/lib/usage-trace";
import { traceRootId } from "../../shared/usage-trace";
import { TraceDialog } from "./usage/TraceView";

export function TurnActivity({ activity, forceOpen = false, children }: {
  activity: ChatTurnActivity;
  forceOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(forceOpen);
  const [tracing, setTracing] = useState(false);
  const detailId = useId();
  const digest = activity.digestMessage?.digest;
  const failedSteps = activity.steps.filter((step) => step.tool?.ok === false);
  const failures = Math.max(failedSteps.length, digest?.tools.reduce((count, tool) => count + tool.failed, 0) ?? 0);
  const count = digest?.toolCalls ?? Math.max(activity.steps.length, digest?.tools.reduce((count, tool) => count + tool.count, 0) ?? 0);
  // The resting line names the failed step, so the reader knows what went wrong without expanding.
  const failedNames = [...new Set(failedSteps.map((step) => step.tool?.name).filter((name): name is string => Boolean(name)))];
  const summary = [
    activity.durationMs === undefined ? null : t("trace.workedFor", { duration: formatDuration(activity.durationMs) }),
    t(count === 1 ? "chat.activity.step" : "chat.activity.steps", { count }),
    failures ? t("chat.activity.failed", { count: failures }) : null,
    failedNames.length ? t("chat.activity.failedSteps", { names: failedNames.join(", ") }) : null,
  ].filter(Boolean).join(" · ");
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);
  return (
    <div className="-mt-3 min-w-0 max-w-full text-[12px] text-ink-secondary [&_summary]:min-h-11" data-testid="turn-activity">
      <button
        type="button"
        aria-label={`${t(open ? "chat.activity.hide" : "chat.activity.show")} · ${summary}`}
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-11 min-w-11 max-w-full items-center gap-1.5 rounded-lg px-1 text-left hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
      >
        {failures ? <CircleAlert size={12} className="shrink-0" aria-hidden /> : <Check size={12} className="shrink-0" aria-hidden />}
        <span>{summary}</span>
        <ChevronRight size={12} className={open ? "shrink-0 rotate-90" : "shrink-0"} aria-hidden />
      </button>
      <div id={detailId} hidden={!open} className={open ? "flex min-w-0 flex-col gap-2 pb-2" : undefined}>
        {open && <>{failures > 0 && <p className="max-w-prose px-1">{t("chat.activity.failureImpact")}</p>}
        {children}
        {digest && <div data-mid={activity.digestMessage?.id}>
          <button type="button" data-testid="view-trace" onClick={() => setTracing(true)} className="min-h-11 min-w-11 rounded-lg px-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent">
            {t("trace.view")}
          </button>
        </div>}</>}
      </div>
      {tracing && digest && <TraceDialog id={traceRootId(digest.threadId, digest.turnId)} at={digest.at} onClose={() => setTracing(false)} />}
    </div>
  );
}
