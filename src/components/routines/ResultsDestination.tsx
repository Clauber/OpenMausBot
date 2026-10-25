import { useId } from "react";
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { ROUTINE_DEFAULT_RESULTS_THREAD, ROUTINE_OWN_RESULTS_THREAD } from "../../../shared/routines";
import { Select } from "../Select";

export function ResultsDestination({ bot, value, allowCurrent = false, onChange }: {
  bot?: Bot;
  value: string | null | undefined;
  allowCurrent?: boolean;
  onChange: (threadId: string | null | undefined) => void;
}) {
  const id = useId();
  const tasks = (bot?.tasks ?? []).filter((task) => !task.routineRunId);
  const selectedMissing = typeof value === "string" && value !== ROUTINE_OWN_RESULTS_THREAD && value !== ROUTINE_DEFAULT_RESULTS_THREAD && !tasks.some((task) => task.threadId === value);
  const groups = [...(bot?.projects ?? []), { id: "", name: t("folder.none") }];
  return <div className="min-w-0 space-y-1.5">
    <label htmlFor={id} className="block text-[12px] font-medium text-ink">{t("routines.results.label")}</label>
    <Select className="w-full" id={id} aria-describedby={`${id}-help`} disabled={!bot} value={value ?? (value === null ? "new" : "current")}
      onChange={(event) => onChange(event.target.value === "new" ? null : event.target.value === "current" ? undefined : event.target.value)}>
      {allowCurrent && <option value="current">{t("routines.results.keep")}</option>}
      <option value="new">{t("routines.results.main")}</option>
      <option value={ROUTINE_OWN_RESULTS_THREAD}>{t("routines.results.own")}</option>
      <option value={ROUTINE_DEFAULT_RESULTS_THREAD}>{t("routines.results.default")}</option>
      {selectedMissing && <option value={value!} disabled>{t("routines.results.unavailable")}</option>}
      {groups.map((group) => {
        const members = tasks.filter((task) => group.id ? task.projectId === group.id : !bot?.projects?.some((project) => project.id === task.projectId));
        return members.length ? <optgroup key={group.id} label={group.name}>
          {members.map((task) => <option key={task.threadId} value={task.threadId}>{task.title}</option>)}
        </optgroup> : null;
      })}
    </Select>
    <p id={`${id}-help`} className="text-[11px] leading-relaxed text-ink-secondary">{t("routines.results.mainHelp")}</p>
  </div>;
}
