// The per-bot grant UI shared by Settings → Apps → Access and Settings →
// Skills: rows (an app, a skill) by bots, one switch per pair, plus a "this
// bot's rows" view. It knows nothing about what is being granted; callers
// say which rows exist, which are on, which are locked and what a switch
// writes, so both pages look and behave the same.
import type { ReactNode } from "react";
import { Loader2, Wrench } from "lucide-react";

import { cn } from "@/lib/cn";
import type { Bot } from "@/state/store";

import { BotAvatar } from "./Avatar";
import { Switch } from "./SettingsPrimitives";

export interface GrantBadge {
  text: string;
  tone?: "info" | "warn";
  title?: string;
}

export interface GrantRow {
  id: string;
  label: string;
  /** a line under the label: what turning it on will do, or why it cannot be */
  note?: string | null;
  badges?: GrantBadge[];
  /** heading the row sits under in the matrix; rows keep their given order */
  group?: string;
  title?: string;
}

export interface GrantRules {
  isOn: (row: GrantRow, bot: Bot) => boolean;
  /** why this pair's switch is locked, or null */
  lockFor: (row: GrantRow, bot: Bot) => string | null;
  onToggle: (row: GrantRow, bot: Bot, on: boolean) => void;
  toggleLabel: (row: GrantRow, bot: Bot) => string;
}

export function GrantBadgeChips({ badges }: { badges?: GrantBadge[] }) {
  if (!badges?.length) return null;
  return (
    <span className="ml-1.5 inline-flex shrink-0 items-center gap-1">
      {badges.map((badge) => (
        <span
          key={badge.text}
          title={badge.title}
          data-grant-badge={badge.text}
          className={cn(
            "rounded-full px-1.5 py-px text-[10px] font-medium leading-4",
            badge.tone === "warn" ? "bg-warning/15 text-warning" : "bg-control text-ink-secondary",
          )}
        >
          {badge.text}
        </span>
      ))}
    </span>
  );
}

function Cell({ row, bot, rules }: { row: GrantRow; bot: Bot; rules: GrantRules }) {
  const checked = rules.isOn(row, bot);
  const lock = rules.lockFor(row, bot);
  return (
    <Switch
      data-grant-cell={`${row.id}:${bot.id}`}
      checked={checked}
      disabled={lock !== null}
      title={lock ?? undefined}
      aria-label={rules.toggleLabel(row, bot)}
      onClick={() => rules.onToggle(row, bot, !checked)}
    />
  );
}

/** Rows × bots. Wide fleets scroll sideways under a pinned first column. */
export function GrantMatrix({ rows, bots, rules, rowColumnTitle }: {
  rows: GrantRow[];
  bots: Bot[];
  rules: GrantRules;
  rowColumnTitle: string;
}) {
  const groups: Array<{ title: string | undefined; rows: GrantRow[] }> = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last && last.title === row.group) last.rows.push(row);
    else groups.push({ title: row.group, rows: [row] });
  }
  return (
    <div data-grant-matrix className="overflow-x-auto rounded-xl border border-hairline/40 bg-menu">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <th scope="col" className="sticky left-0 z-[1] bg-menu px-3 py-3 text-left text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">
              {rowColumnTitle}
            </th>
            {bots.map((bot) => (
              <th key={bot.id} scope="col" data-grant-bot={bot.id} className="min-w-[88px] max-w-[120px] px-3 py-3 text-center align-bottom font-normal">
                <span className="mx-auto flex size-7 items-center justify-center overflow-hidden rounded-full">
                  <BotAvatar bot={bot} size={22} animated={false} />
                </span>
                <span className="mt-1 block truncate text-[12px] font-medium text-ink" title={bot.name}>{bot.name}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((group, at) => (
            <GroupRows key={`${group.title ?? ""}:${at}`} title={group.title} rows={group.rows} bots={bots} rules={rules} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GroupRows({ title, rows, bots, rules }: { title: string | undefined; rows: GrantRow[]; bots: Bot[]; rules: GrantRules }) {
  return (
    <>
      {title && (
        <tr>
          <th colSpan={bots.length + 1} scope="colgroup" className="sticky left-0 px-3 pb-1 pt-4 text-left text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">
            {title}
          </th>
        </tr>
      )}
      {rows.map((row) => (
        <tr key={row.id} data-grant-row={row.id} className="border-t border-hairline/30">
          <th scope="row" className="sticky left-0 z-[1] min-w-[220px] max-w-[260px] bg-menu px-3 py-2.5 text-left align-middle font-normal">
            <div className="flex min-w-0 items-center text-[13.5px] font-medium text-ink" title={row.title ?? row.id}>
              <span className="truncate">{row.label}</span>
              <GrantBadgeChips badges={row.badges} />
            </div>
            {row.note && <div className="mt-0.5 text-[11.5px] leading-snug text-ink-secondary">{row.note}</div>}
          </th>
          {bots.map((bot) => (
            <td key={bot.id} className="px-3 py-2.5 text-center align-middle">
              <Cell row={row} bot={bot} rules={rules} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export interface GrantDetail {
  buttonLabel: string;
  loadingLabel: string;
  state: "idle" | "loading" | "error";
  errorText?: string;
  onLoad: () => void;
  /** what to show under a row that is on for this bot, once loaded */
  renderRow: (row: GrantRow) => ReactNode;
}

/** One bot's rows: what is on for it, what is off, and optionally a detail
 * (the tools its apps give it) on request. */
export function GrantBotView({ bot, rows, rules, summary, onTitle, offTitle, lockText, detail }: {
  bot: Bot;
  rows: GrantRow[];
  rules: GrantRules;
  summary: string;
  onTitle: string;
  offTitle: string;
  /** a line shown when this bot's switches are locked as a whole */
  lockText?: string | null;
  detail?: GrantDetail;
}) {
  const on = rows.filter((row) => rules.isOn(row, bot));
  const off = rows.filter((row) => !rules.isOn(row, bot));
  const heading = (text: string) => <div className="px-3 pb-1 pt-3 text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">{text}</div>;
  const line = (row: GrantRow) => {
    const granted = rules.isOn(row, bot);
    return (
      <div key={row.id} data-grant-bot-row={row.id} className="px-3 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center text-[13.5px] font-medium text-ink" title={row.title ?? row.id}>
              <span className="truncate">{row.label}</span>
              <GrantBadgeChips badges={row.badges} />
            </div>
            {row.note && <div className="mt-0.5 text-[11.5px] leading-snug text-ink-secondary">{row.note}</div>}
          </div>
          <Cell row={row} bot={bot} rules={rules} />
        </div>
        {granted && detail?.renderRow(row)}
      </div>
    );
  };
  return (
    <div data-grant-bot-view={bot.id} className="rounded-xl border border-hairline/40 bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline/40 px-3 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full">
            <BotAvatar bot={bot} size={26} animated={false} />
          </span>
          <div className="min-w-0">
            <div className="truncate text-[14px] font-medium text-ink">{bot.name}</div>
            <div className="text-[12px] text-ink-secondary">{summary}</div>
          </div>
        </div>
        {detail && (
          <button
            type="button"
            data-grant-detail-button
            onClick={detail.onLoad}
            disabled={detail.state === "loading"}
            className="flex items-center gap-1.5 rounded-lg bg-control px-3 py-1.5 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-60"
          >
            {detail.state === "loading" ? <Loader2 size={13} className="animate-spin" /> : <Wrench size={13} />}
            {detail.state === "loading" ? detail.loadingLabel : detail.buttonLabel}
          </button>
        )}
      </div>
      {lockText && <div className="px-3 pt-2 text-[12px] text-ink-secondary">{lockText}</div>}
      {detail?.state === "error" && <div role="alert" className="px-3 pt-2 text-[12px] text-danger">{detail.errorText}</div>}
      <div className="divide-y divide-hairline/30">
        {on.length > 0 && heading(onTitle)}
        {on.map(line)}
        {off.length > 0 && heading(offTitle)}
        {off.map(line)}
      </div>
    </div>
  );
}

/** The title, view switch and per-bot picker both pages wear. */
export function GrantManagerHeader({ titleId, title, intro, view, onView, bots, selectedId, onSelect, labels }: {
  titleId: string;
  title: string;
  intro: string;
  view: "row" | "bot";
  onView: (view: "row" | "bot") => void;
  bots: Bot[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  labels: { byRow: string; byBot: string; viewAria: string; pickBot: string };
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h3 id={titleId} className="text-[15px] font-medium text-ink">{title}</h3>
        <p className="mt-0.5 max-w-[640px] text-[12.5px] text-ink-secondary">{intro}</p>
      </div>
      <div className="flex items-center gap-2">
        {view === "bot" && selectedId && (
          <select
            aria-label={labels.pickBot}
            data-grant-bot-select
            value={selectedId}
            onChange={(event) => onSelect(event.target.value)}
            className="max-w-[200px] rounded-lg bg-control px-3 py-1.5 text-[12.5px] text-ink focus:outline-none"
          >
            {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
          </select>
        )}
        <div className="flex rounded-lg bg-control/70 p-0.5" role="group" aria-label={labels.viewAria}>
          {(["row", "bot"] as const).map((id) => (
            <button
              key={id}
              type="button"
              data-grant-view={id}
              aria-pressed={view === id}
              onClick={() => onView(id)}
              className={cn("rounded-md px-3 py-1 text-[12.5px] font-medium", view === id ? "bg-accent text-accent-ink" : "text-ink-secondary hover:text-ink")}
            >
              {id === "row" ? labels.byRow : labels.byBot}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

