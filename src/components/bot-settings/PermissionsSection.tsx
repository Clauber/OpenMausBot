// LocalComputerAutoWarning remembers its bot, so a bot switch while it is up never applies the choice to the new bot.
import { useEffect, useState } from "react";
import { Crown } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { api, useStore, type Bot } from "@/state/store";
import type { LocaleKey } from "@/locales";
import type { ApprovalMode } from "../../../shared/approval-mode";
import { DEFAULT_OUTBOUND_POLICY, type OutboundPolicy } from "../../../shared/outbound";
import { ApprovalModeSelector } from "../ApprovalModeSelector";
import { ApprovalRulesCard } from "./ApprovalRulesCard";
import { CommandAllowlistDialog } from "../CommandAllowlistDialog";
import { LocalComputerAutoWarning } from "../LocalComputerAutoWarning";
import { Switch } from "../SettingsPrimitives";
import { ManagedTeamsSettings } from "./ManagedTeamsSettings";
import { MasterChiefSettings } from "./MasterChiefSettings";
import { ProposalStatus } from "./ProposalStatus";
import type { useBotSettingsDerived } from "./useBotSettingsDerived";
import { useBotEditor } from "./BotEditorContext";

export type PermissionsPart = "chief" | "peers" | "approval" | "outbound";

export function PermissionsSection({
  bot,
  derived,
  parts,
}: {
  bot: Bot;
  derived: ReturnType<typeof useBotSettingsDerived>;
  parts?: readonly PermissionsPart[];
}) {
  const { patch, engine, canCoordinate, approvalMode, trustedModesAvailable, sectionName, currentChief } = derived;
  const { state, dispatch } = useStore();
  const ownerOrAdmin = useOwnerOrAdmin();
  const { draft } = useBotEditor();
  const displaySectionName = sectionName === "General" ? t("botAccess.teams.general") : sectionName;
  const [localAutoWarning, setLocalAutoWarning] = useState<string | null>(null);
  const [commandAllowlistTarget, setCommandAllowlistTarget] = useState<{ botId: string; botName: string } | null>(null);
  const shows = (part: PermissionsPart) => !parts || parts.includes(part);
  const applyFullEverywhere = () =>
    dispatch({ type: "updateBot", botId: bot.id, patch: { approvalMode: "full", applyToAllThreads: true } });
  // A level picked while the bot works: first how to apply it (stop and
  // continue now, or when the turn finishes), then the usual warnings.
  const [busyChoice, setBusyChoice] = useState<{ botId: string; mode: ApprovalMode } | null>(null);
  const [whenBusy, setWhenBusy] = useState<"next-turn" | "restart" | null>(null);
  const scheduleApprovalMode = (
    botId: string,
    mode: ApprovalMode,
    timing: "next-turn" | "restart",
    extra: { applyToAllThreads?: boolean; acknowledgeLocalAuto?: boolean } = {},
  ) => {
    api(`/api/bots/${botId}/approval-mode-when-busy`, {
      method: "POST",
      body: JSON.stringify({ approvalMode: mode, whenBusy: timing, ...extra }),
    }).catch((error) => {
      dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
      setTimeout(() => dispatch({ type: "error", message: null }), 6000);
    });
  };
  const chooseApprovalMode = (mode: ApprovalMode, timing: "next-turn" | "restart" | null) => {
    setWhenBusy(timing);
    if (mode === "full" && timing) {
      scheduleApprovalMode(bot.id, "full", timing, { applyToAllThreads: true });
      return;
    }
    if (mode === "full") {
      applyFullEverywhere();
      return;
    }
    if (mode === "auto" && bot.computer === "local" && approvalMode !== "auto") {
      setLocalAutoWarning(bot.id);
      return;
    }
    if (timing) scheduleApprovalMode(bot.id, mode, timing);
    else patch({ approvalMode: mode });
  };
  const setApprovalMode = (mode: ApprovalMode) => {
    if (bot.busy) {
      if (mode === (bot.pendingApprovalMode ?? approvalMode)) return;
      // Back to the current level just withdraws the pending change.
      if (mode === approvalMode) return scheduleApprovalMode(bot.id, mode, "next-turn");
      setBusyChoice({ botId: bot.id, mode });
      return;
    }
    if (mode === approvalMode) return;
    chooseApprovalMode(mode, null);
  };

  return (
    <div className="flex flex-col gap-4">
      {shows("chief") && <div
        className={cn(
          "rounded-xl border p-4",
          bot.chiefOfStaff ? "border-accent/40 bg-accent/10" : "border-hairline/40 bg-card",
        )}
      >
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-lg",
              bot.chiefOfStaff ? "bg-accent text-white" : "bg-control text-ink-secondary",
            )}
          >
            <Crown size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-medium text-ink">{t("permissions.chief.title")}</div>
            <div className="text-[11.5px] text-ink-secondary">{t("permissions.chief.oneFor", { section: displaySectionName })}</div>
          </div>
          <Switch
            checked={Boolean(bot.chiefOfStaff)}
            aria-label={t("permissions.chief.title")}
            disabled={!bot.chiefOfStaff && !canCoordinate}
            onClick={() => patch({ chiefOfStaff: !bot.chiefOfStaff })}
            title={!bot.chiefOfStaff && !canCoordinate ? t("permissions.cannotCoordinate") : undefined}
            className="disabled:cursor-not-allowed"
          />
        </div>
        <div className="mt-3 text-[13px] leading-relaxed text-ink-secondary">
          {bot.chiefOfStaff && !canCoordinate
            ? t("permissions.chief.unsupportedCurrent")
            : bot.chiefOfStaff
              ? t("permissions.chief.active", { section: displaySectionName })
              : !canCoordinate
                ? t("permissions.chief.unsupported")
                : currentChief
                  ? t("permissions.chief.replace", { section: displaySectionName, current: currentChief.name })
                  : t("permissions.chief.make", { section: displaySectionName })}
        </div>
        <ProposalStatus bot={bot} kind="chief" />
        {bot.chiefOfStaff && <ManagedTeamsSettings
          key={bot.id + JSON.stringify(bot.managedSections ?? [])}
          name={bot.name} ownTeam={bot.section?.trim() || ""}
          teams={["", ...(state.sections ?? []), ...[...state.bots, ...state.groups].map(member => member.section?.trim() || "")]}
          allowed={bot.managedSections ?? []}
          onSave={managedSections => patch({ managedSections, acknowledgePeerScope: true })}
        />}
        {bot.chiefOfStaff && <ProposalStatus bot={bot} kind="owner" />}
        {bot.chiefOfStaff && ownerOrAdmin === true && <MasterChiefSettings key={bot.id} bot={bot} />}
      </div>}

      {shows("peers") && <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
        <div>
          <div className="text-[15px] font-medium text-ink">{t("permissions.peers.title")}</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            {bot.approvePeerComms
              ? t("permissions.peers.on")
              : t("permissions.peers.off")}
          </div>
          <ProposalStatus bot={bot} kind="owner" />
        </div>
        <Switch
          checked={Boolean(bot.approvePeerComms)}
          aria-label={t("permissions.peers.title")}
          disabled={!bot.approvePeerComms && !canCoordinate}
          onClick={() => patch({ approvePeerComms: !bot.approvePeerComms })}
          title={!bot.approvePeerComms && !canCoordinate ? t("permissions.cannotCoordinate") : undefined}
          className="disabled:cursor-not-allowed"
        />
      </div>}

      {shows("approval") && <div className="rounded-xl bg-card p-4">
        <div className="text-[15px] font-medium text-ink">{t("permissions.approval.title")}</div>
        <div className="mt-0.5 text-[13px] text-ink-secondary">
          {draft ? t("permissions.approval.draft") : t("permissions.approval.help")}
        </div>
        <ProposalStatus bot={bot} kind="owner" />
        <div className="mt-3">
          <ApprovalModeSelector
            approvalMode={bot.approvalMode}
            autoApprove={bot.autoApprove}
            providerName={engine?.displayName ?? bot.name}
            driverKind={engine?.driverKind ?? ""}
            onSelect={setApprovalMode}
            menuDirection="down"
            wide
            trustedModesAvailable={trustedModesAvailable}
            onManageCommandAllowlist={!draft && ownerOrAdmin === true ? () => setCommandAllowlistTarget({ botId: bot.id, botName: bot.name }) : undefined}
          />
        </div>
        {!draft && bot.pendingApprovalMode && bot.pendingApprovalMode !== approvalMode && <div className="mt-2 text-[13px] text-ink-secondary">
          {t("approvalMode.pending", { mode: t(`approvalMode.${bot.pendingApprovalMode}.label` as LocaleKey) })}
          {" "}<button type="button" className="text-accent hover:underline"
            onClick={() => scheduleApprovalMode(bot.id, approvalMode, "next-turn")}>{t("approvalMode.pendingKeep")}</button>
        </div>}
        {!draft && approvalMode === "full" && <button
          type="button" disabled={Boolean(bot.busy)}
          className="mt-3 text-[13px] text-accent hover:underline disabled:opacity-40"
          onClick={applyFullEverywhere}
        >{t("permissions.approval.applyFull")}</button>}
        {!draft && ownerOrAdmin === true && <button
          type="button"
          className="mt-3 block text-[13px] text-accent hover:underline"
          onClick={() => setCommandAllowlistTarget({ botId: bot.id, botName: bot.name })}
        >{t("commandAllowlist.manage")}</button>}
      </div>}

      {commandAllowlistTarget && <CommandAllowlistDialog
        key={`command-allowlist:${commandAllowlistTarget.botId}`}
        {...commandAllowlistTarget}
        onClose={() => setCommandAllowlistTarget(null)}
      />}
      {!draft && ownerOrAdmin === true && <ApprovalRulesCard key={`approval-rules:${bot.id}`} bot={bot} />}
      {!draft && shows("outbound") && <OutboundControl key={bot.id} bot={bot} onChange={(outbound) => patch({ outbound })} />}
      <LocalComputerAutoWarning
        open={localAutoWarning !== null}
        onCancel={() => setLocalAutoWarning(null)}
        onConfirm={() => {
          const target = localAutoWarning;
          setLocalAutoWarning(null);
          if (!target) return;
          if (whenBusy) scheduleApprovalMode(target, "auto", whenBusy, { acknowledgeLocalAuto: true });
          else dispatch({ type: "updateBot", botId: target, patch: { approvalMode: "auto", acknowledgeLocalAuto: true } });
        }}
      />
      {busyChoice && busyChoice.botId === bot.id && <BusyApprovalChoice
        botName={bot.name}
        mode={busyChoice.mode}
        onCancel={() => setBusyChoice(null)}
        onChoose={(timing) => {
          setBusyChoice(null);
          chooseApprovalMode(busyChoice.mode, timing);
        }}
      />}
    </div>
  );
}

function OutboundControl({ bot, onChange }: { bot: Bot; onChange: (policy: OutboundPolicy) => void }) {
  const policy = bot.outbound ?? DEFAULT_OUTBOUND_POLICY;
  const [today, setToday] = useState<number | null>(null);
  const [capDraft, setCapDraft] = useState(String(policy.dailyCap));

  useEffect(() => {
    setCapDraft(String(policy.dailyCap));
  }, [policy.dailyCap]);

  useEffect(() => {
    let alive = true;
    void fetch(`/api/bots/${bot.id}/outbound`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { today?: number } | null) => {
        if (alive && body && typeof body.today === "number") setToday(body.today);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [bot.id, bot.outbound]);

  const commitCap = () => {
    const parsed = Number(capDraft);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
      setCapDraft(String(policy.dailyCap));
      return;
    }
    if (parsed !== policy.dailyCap) onChange({ policy: policy.policy, dailyCap: parsed });
  };

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{t("permissions.outbound.title")}</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
        {t("permissions.outbound.help")}
      </div>
      <div className="mt-3 flex gap-1 rounded-lg bg-inset p-0.5">
        {(
          [
            ["ask", t("permissions.outbound.ask"), t("permissions.outbound.askHint")],
            ["allow", t("permissions.outbound.allow"), t("permissions.outbound.allowHint")],
          ] as const
        ).map(([value, label, hint]) => (
          <button
            key={value}
            title={hint}
            type="button"
            aria-pressed={policy.policy === value}
            onClick={() => {
              if (value !== policy.policy) onChange({ policy: value, dailyCap: policy.dailyCap });
            }}
            className={cn(
              "flex-1 rounded-md px-2.5 py-1.5 text-[13px] font-medium",
              policy.policy === value ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {policy.policy === "allow" && (
        <div className="mt-3 flex flex-wrap items-center gap-3 text-[13px] text-ink-secondary">
          <label className="flex items-center gap-2">
            {t("permissions.outbound.upTo")}
            <input
              type="number"
              min={1}
              max={1000}
              value={capDraft}
              onChange={(event) => setCapDraft(event.target.value)}
              onBlur={commitCap}
              onKeyDown={(event) => {
                if (event.key === "Enter") (event.target as HTMLInputElement).blur();
              }}
              aria-label={t("permissions.outbound.dailyLimit")}
              className="w-20 rounded-md bg-inset px-2 py-1 text-[13px] text-ink tabular-nums outline-none focus:ring-1 focus:ring-accent"
            />
            {t("permissions.outbound.perDay")}
          </label>
          <span className="tabular-nums">
            {today === null ? "" : t("permissions.outbound.usedToday", { today, cap: policy.dailyCap })}
          </span>
        </div>
      )}
    </div>
  );
}

/** How a level picked mid-run should land: the running provider session
 * keeps the level it started with, so it is either stopped and continued
 * under the new one, or the change waits for the turn to finish. */
function BusyApprovalChoice({ botName, mode, onCancel, onChoose }: {
  botName: string;
  mode: ApprovalMode;
  onCancel: () => void;
  onChoose: (timing: "next-turn" | "restart") => void;
}) {
  const option = "w-full rounded-xl border border-hairline/40 px-4 py-3 text-left hover:bg-raised";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6"
      onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <div role="dialog" aria-modal="true" aria-labelledby="busy-approval-title"
        className="w-full max-w-[440px] rounded-2xl border border-hairline/40 bg-panel p-5 shadow-2xl">
        <h2 id="busy-approval-title" className="text-[15px] font-semibold text-ink">
          {t("approvalMode.busy.title", { name: botName, mode: t(`approvalMode.${mode}.label` as LocaleKey) })}
        </h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">{t("approvalMode.busy.body", { name: botName })}</p>
        <div className="mt-4 flex flex-col gap-2">
          <button type="button" className={option} onClick={() => onChoose("restart")}>
            <div className="text-[14px] font-medium text-ink">{t("approvalMode.busy.restart")}</div>
            <div className="text-[12.5px] text-ink-secondary">{t("approvalMode.busy.restartHint")}</div>
          </button>
          <button type="button" className={option} onClick={() => onChoose("next-turn")}>
            <div className="text-[14px] font-medium text-ink">{t("approvalMode.busy.nextTurn")}</div>
            <div className="text-[12.5px] text-ink-secondary">{t("approvalMode.busy.nextTurnHint")}</div>
          </button>
        </div>
        <div className="mt-4 flex justify-end">
          <button type="button" onClick={onCancel}
            className="rounded-xl px-4 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink">
            {t("approvalMode.busy.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
