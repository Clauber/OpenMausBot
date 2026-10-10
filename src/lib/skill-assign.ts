// Settings → Skills → Assign: which bot has which library skill. The same
// rules the app pages follow (see mcp-access.ts), over the skills library's
// own assignment route, so a change reaches the bot's next turn the way every
// other assignment does.
import { t } from "@/lib/i18n";
import type { GrantBadge, GrantRow } from "@/components/GrantGrid";
import type { SkillsLibrarySkillWire } from "../../shared/wire";

export type SkillSourceKind = "hermes" | "shared" | "local" | "other";

/** Library skills carry where they came from as `<source>:<path>` (a mirror
 * import) or a bare marker like `local-import`. */
export function skillSourceKind(source: string): SkillSourceKind {
  const head = source.split(":", 1)[0]!;
  if (head === "hermes" || head === "shared") return head;
  if (head === "local-import") return "local";
  return "other";
}

export function skillBadges(skill: SkillsLibrarySkillWire): GrantBadge[] {
  const kind = skillSourceKind(skill.source);
  const badges: GrantBadge[] = [];
  const label = kind === "hermes" ? t("skills.assign.source.hermes")
    : kind === "shared" ? t("skills.assign.source.shared")
      : kind === "local" ? t("skills.assign.source.local") : null;
  if (label) badges.push({ text: label, title: skill.source });
  if (!skill.enabled) badges.push({ text: t("skills.assign.notApproved") });
  if (skill.tags.includes("luna-only")) {
    badges.push({ text: t("skills.assign.needsLuna"), tone: "warn", title: skill.warnings.find((warning) => warning.startsWith("Needs Hermes or Luna")) ?? t("skills.assign.needsLunaHint") });
  }
  return badges;
}

export function buildSkillRows(skills: readonly SkillsLibrarySkillWire[], query: string): GrantRow[] {
  const needle = query.trim().toLowerCase();
  return skills
    .filter((skill) => !needle || [skill.name, skill.description, skill.source, ...skill.tags].some((part) => part.toLowerCase().includes(needle)))
    .map((skill) => ({
      id: skill.name,
      label: skill.name,
      note: skill.description,
      badges: skillBadges(skill),
      title: skill.source,
    }));
}

export function skillOn(skill: Pick<SkillsLibrarySkillWire, "assignedBots">, botId: string): boolean {
  return skill.assignedBots.some((bot) => bot.id === botId);
}

/** An unreviewed skill cannot be handed out; taking one away is always fine. */
export function skillLock(skill: Pick<SkillsLibrarySkillWire, "enabled">, on: boolean): string | null {
  return !skill.enabled && !on ? t("skills.assign.lockedUnapproved") : null;
}

/** The bot's whole list after one change. The route replaces the list, so
 * this starts from what the library says the bot has now. */
export function nextSkillAssignments(
  skills: readonly SkillsLibrarySkillWire[],
  botId: string,
  name: string,
  on: boolean,
): string[] {
  const current = skills.filter((skill) => skillOn(skill, botId)).map((skill) => skill.name);
  return on ? [...new Set([...current, name])] : current.filter((skill) => skill !== name);
}

export async function setSkillAssignment(
  api: (path: string, init?: RequestInit) => Promise<unknown>,
  skills: readonly SkillsLibrarySkillWire[],
  botId: string,
  name: string,
  on: boolean,
): Promise<void> {
  await api(`/api/bots/${encodeURIComponent(botId)}/skills-library`, {
    method: "PUT",
    body: JSON.stringify({ skills: nextSkillAssignments(skills, botId, name, on) }),
  });
}
