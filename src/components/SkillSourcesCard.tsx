// Settings → Skills → Library: the skill folders mirrored from other
// machines, and the import into the library. Nothing here writes to a
// source; an import lands unapproved, and anything that needs Hermes or Luna,
// or that embeds a secret-looking value, waits here until it is named.
import { useCallback, useEffect, useState } from "react";

import { t } from "@/lib/i18n";
import { api } from "@/state/store";

import { Card } from "./SettingsPrimitives";

export interface SourceSkillWire {
  name: string;
  source: string;
  category: string;
  description: string;
  lunaDependent: string[];
  secretLiterals: string[];
  converted: string[];
  duplicateOf?: string;
  error?: string;
  libraryState: "same" | "changed" | null;
}
export interface SourceInfoWire { id: string; label: string; count: number; present: boolean }
interface ImportResult { imported: string[]; held: Array<{ name: string; reason: string }>; conflicts: unknown[] }

/** What a bulk import would bring in, and what it would hold back. */
export function summarizeSources(skills: readonly SourceSkillWire[]) {
  const fresh = skills.filter((skill) => !skill.error && !skill.duplicateOf && skill.libraryState === null);
  const clean = fresh.filter((skill) => skill.lunaDependent.length === 0 && skill.secretLiterals.length === 0);
  const held = fresh.filter((skill) => skill.lunaDependent.length > 0 || skill.secretLiterals.length > 0);
  return {
    clean,
    held,
    conflicts: skills.filter((skill) => skill.duplicateOf && skill.libraryState === null),
    inLibrary: (source: string) => skills.filter((skill) => skill.source === source && skill.libraryState !== null).length,
  };
}

export function SkillSourcesCard({ onImported }: { onImported: () => Promise<unknown> }) {
  const [sources, setSources] = useState<SourceInfoWire[] | null>(null);
  const [skills, setSkills] = useState<SourceSkillWire[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    try {
      const body = await api("/api/skill-sources");
      setSources(body.sources ?? []);
      setSkills(body.skills ?? []);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("skills.sources.loadError"));
      setSources((current) => current ?? []);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const run = async (request: Record<string, unknown>) => {
    if (working) return;
    setWorking(true);
    setError("");
    setMessage("");
    try {
      const result = await api("/api/skill-sources/import", { method: "POST", body: JSON.stringify(request) }) as ImportResult;
      setMessage(t("skills.sources.result", { imported: result.imported.length, held: result.held.length }));
      await Promise.all([load(), onImported()]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("skills.sources.loadError"));
    } finally {
      setWorking(false);
    }
  };

  const summary = summarizeSources(skills);
  return (
    <Card title={t("skills.sources.title")} subtitle={t("skills.sources.subtitle")}>
      <div data-skill-sources className="flex flex-col gap-3">
        {sources === null ? (
          <div className="text-[12px] text-ink-secondary">{t("skills.library.loading")}</div>
        ) : !sources.some((source) => source.present) ? (
          <div className="rounded-lg bg-inset px-3 py-2 text-[12px] text-ink-secondary">{t("skills.sources.none")}</div>
        ) : (
          <>
            <ul className="divide-y divide-hairline/40 overflow-hidden rounded-lg border border-hairline/40">
              {sources.map((source) => (
                <li key={source.id} data-skill-source={source.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-ink">{source.label}</div>
                    <div className="text-[11.5px] text-ink-secondary">
                      {source.present ? t("skills.sources.count", { count: source.count, imported: summary.inLibrary(source.id) }) : t("skills.sources.notMirrored")}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                data-skill-import-all
                disabled={working || summary.clean.length === 0}
                onClick={() => void run({ all: true })}
                className="rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
              >
                {working ? t("skills.sources.importing") : t("skills.sources.import", { count: summary.clean.length })}
              </button>
              {message && <span className="text-[12px] text-ink-secondary">{message}</span>}
            </div>
            {summary.conflicts.length > 0 && (
              <div className="text-[11.5px] text-ink-secondary">{t("skills.sources.conflicts", { count: summary.conflicts.length })}</div>
            )}
            {summary.held.length > 0 && (
              <div data-skill-held>
                <div className="mb-1 text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">{t("skills.sources.heldTitle")}</div>
                <div className="max-h-72 divide-y divide-hairline/40 overflow-y-auto rounded-lg border border-hairline/40">
                  {summary.held.map((skill) => (
                    <div key={`${skill.source}:${skill.name}`} data-skill-held-row={skill.name} className="flex items-start justify-between gap-3 px-3 py-2">
                      <div className="min-w-0">
                        <div className="truncate font-mono text-[12.5px] text-ink">{skill.name} <span className="font-sans text-[11px] text-ink-secondary">· {skill.source}{skill.category ? ` / ${skill.category}` : ""}</span></div>
                        {skill.secretLiterals.length > 0 && <div className="text-[11px] text-warning">{t("skills.sources.heldSecret", { kinds: skill.secretLiterals.join(", ") })}</div>}
                        {skill.lunaDependent.length > 0 && <div className="text-[11px] text-warning">{t("skills.sources.heldLuna", { reasons: skill.lunaDependent.join("; ") })}</div>}
                      </div>
                      <button
                        type="button"
                        disabled={working}
                        onClick={() => {
                          if (skill.secretLiterals.length > 0) {
                            if (!window.confirm(t("skills.sources.confirmSecret", { name: skill.name }))) return;
                            void run({ names: [skill.name], include: [skill.name], reviewedSecrets: [skill.name] });
                          } else {
                            void run({ names: [skill.name], include: [skill.name] });
                          }
                        }}
                        className="shrink-0 rounded-lg bg-control px-2.5 py-1 text-[11.5px] text-ink hover:bg-raised-hover disabled:opacity-50"
                      >
                        {skill.secretLiterals.length > 0 ? t("skills.sources.importReviewed") : t("skills.sources.importAnyway")}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
        {error && <div role="alert" className="text-[12px] text-danger">{error}</div>}
      </div>
    </Card>
  );
}
