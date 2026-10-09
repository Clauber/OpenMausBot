// Settings → Skills → Assign: the same per-bot grant grid Apps → Access uses,
// over the skills library. A switch edits that bot's assigned-skills list
// through the library's own route, so it lands on the bot's next turn.
import { useRef, useState } from "react";

import { buildSkillRows, setSkillAssignment, skillLock, skillOn } from "@/lib/skill-assign";
import { t } from "@/lib/i18n";
import { api, type Bot } from "@/state/store";

import { GrantBotView, GrantManagerHeader, GrantMatrix, type GrantRules } from "./GrantGrid";
import type { SkillsLibrarySkillWire } from "../../shared/wire";

function skillRules(skills: readonly SkillsLibrarySkillWire[], onToggle: (skill: SkillsLibrarySkillWire, bot: Bot, on: boolean) => void): GrantRules {
  const byName = new Map(skills.map((skill) => [skill.name, skill] as const));
  return {
    isOn: (row, bot) => skillOn(byName.get(row.id)!, bot.id),
    lockFor: (row, bot) => skillLock(byName.get(row.id)!, skillOn(byName.get(row.id)!, bot.id)),
    onToggle: (row, bot, on) => onToggle(byName.get(row.id)!, bot, on),
    toggleLabel: (row, bot) => t("skills.assign.toggle", { bot: bot.name, skill: row.label }),
  };
}

/** The grid or one bot's skills, from the library listing. Pure: the manager
 * below owns the state and the writes. */
export function SkillAssignGrid({ skills, bots, view, bot, query, onToggle }: {
  skills: readonly SkillsLibrarySkillWire[];
  bots: Bot[];
  view: "row" | "bot";
  bot: Bot | null;
  query: string;
  onToggle: (skill: SkillsLibrarySkillWire, bot: Bot, on: boolean) => void;
}) {
  const rows = buildSkillRows(skills, query);
  const rules = skillRules(skills, onToggle);
  if (bots.length === 0) return <div className="rounded-xl bg-inset px-4 py-6 text-center text-[13px] text-ink-secondary">{t("apps.access.noBots")}</div>;
  if (rows.length === 0) return <div className="rounded-xl bg-inset px-4 py-6 text-center text-[13px] text-ink-secondary">{t("skills.assign.noSkills")}</div>;
  if (view === "bot" && bot) {
    return (
      <GrantBotView
        bot={bot}
        rows={rows}
        rules={rules}
        summary={t("skills.assign.botCount", { count: skills.filter((skill) => skillOn(skill, bot.id)).length })}
        onTitle={t("apps.access.onForBot")}
        offTitle={t("apps.access.offForBot")}
      />
    );
  }
  return <GrantMatrix rows={rows} bots={bots} rules={rules} rowColumnTitle={t("skills.assign.skillColumn")} />;
}

export function SkillAssignManager({ skills, bots, query, onChanged }: {
  skills: readonly SkillsLibrarySkillWire[];
  bots: Bot[];
  query: string;
  onChanged: () => Promise<unknown>;
}) {
  const [view, setView] = useState<"row" | "bot">("row");
  const [botId, setBotId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const selected = bots.find((bot) => bot.id === botId) ?? bots[0] ?? null;

  const toggle = async (skill: SkillsLibrarySkillWire, bot: Bot, on: boolean) => {
    if (busy.current) return;
    busy.current = true;
    setError("");
    try {
      await setSkillAssignment(api, skills, bot.id, skill.name, on);
      await onChanged();
    } catch (cause) {
      setError(t("skills.assign.error", { error: cause instanceof Error ? cause.message : String(cause) }));
    } finally {
      busy.current = false;
    }
  };

  return (
    <section data-skill-assign aria-labelledby="skill-assign-title" className="min-w-0">
      <GrantManagerHeader
        titleId="skill-assign-title"
        title={t("skills.assign.title")}
        intro={t("skills.assign.intro")}
        view={view}
        onView={setView}
        bots={bots}
        selectedId={selected?.id ?? null}
        onSelect={setBotId}
        labels={{ byRow: t("skills.assign.bySkill"), byBot: t("apps.access.byBot"), viewAria: t("apps.access.viewAria"), pickBot: t("apps.access.pickBot") }}
      />
      {error && <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>}
      <div className="mt-3">
        <SkillAssignGrid skills={skills} bots={bots} view={view} bot={selected} query={query} onToggle={(skill, bot, on) => void toggle(skill, bot, on)} />
      </div>
    </section>
  );
}
