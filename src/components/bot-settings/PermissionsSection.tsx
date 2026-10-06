// Permissions: how autonomously this bot acts — the approval level (ask /
// auto / full / custom), review-routine approvals, whether it asks before
// contacting other bots, and whether it holds the section's Chief of Staff
// role. Moved from SettingsPanel.tsx (Chief of Staff ~720-755,
// Ask-before-contacting ~757-776, Approval level ~990-1010, Review routine
// approvals ~1013-1050).
//
// The Auto branch of LocalComputerAutoWarning (choosing Auto while
// bot.computer === "local") and the FullAccessWarning live here with their
// triggers; the Works-on-picker branch (turning computer to "local" while
// already on Auto) stays with AccessSection, next to that picker. The
// warnings remember which bot they were opened for, so a bot switch while
// one is up never applies the choice to the newly selected bot.
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
import { CommandAllowlistDialog } from "../CommandAllowlistDialog";
import { FullAccessWarning } from "../FullAccessWarning";
import { LocalComputerAutoWarning } from "../LocalComputerAutoWarning";
import { Switch } from "../SettingsPrimitives";
import { ManagedTeamsSettings } from "./ManagedTeamsSettings";
import { ProposalStatus } from "./ProposalStatus";
import type { useBotSettingsDerived } from "./useBotSettingsDerived";
import { useBotEditor } from "./BotEditorContext";

export function PermissionsSection({
  bot,
  derived,
}: {
  bot: Bot;
  derived: ReturnType<typeof useBotSettingsDerived>;
}) {
  const { patch, engine, canCoordinate, approvalMode, trustedModesAvailable, sectionName, currentChief } = derived;
  const { state, dispatch } = useStore();
  const ownerOrAdmin = useOwnerOrAdmin();
  const { draft } = useBotEditor();
  const [localAutoWarning, setLocalAutoWarning] = useState<string | null>(null);
  const [fullAccessTarget, setFullAccessTarget] = useState<string | null>(null);
  const [allThreads, setAllThreads] = useState(true);
  const [commandAllowlistTarget, setCommandAllowlistTarget] = useState<{ botId: string; botName: string } | null>(null);
  // A level picked while the bot works: first how to apply it (stop and
  // continue now, or when the turn finishes), then the usual warnings.
  const [busyChoice, setBusyChoice] = useState<{ botId: string; mode: ApprovalMode } | null>(null);
  const [whenBusy, setWhenBusy] = useState<"next-turn" | "restart" | null>(null);
  const scheduleApprovalMode = (
    botId: string,
    mode: ApprovalMode,
    timing: "next-turn" | "restart",
    extra: { confirmFullAccess?: boolean; applyToAllThreads?: boolean; acknowledgeLocalAuto?: boolean } = {},
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
    if (mode === "full") {
      setAllThreads(true);
      setFullAccessTarget(bot.id);
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
      <div
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
            <div className="text-[15px] font-medium text-ink">Chief of Staff</div>
            <div className="text-[11.5px] text-ink-secondary">One for {sectionName}</div>
          </div>
          <Switch
            checked={Boolean(bot.chiefOfStaff)}
            aria-label="Chief of Staff"
            disabled={!bot.chiefOfStaff && !canCoordinate}
            onClick={() => patch({ chiefOfStaff: !bot.chiefOfStaff })}
            title={!bot.chiefOfStaff && !canCoordinate ? "This model cannot contact other bots" : undefined}
            className="disabled:cursor-not-allowed"
          />
        </div>
        <div className="mt-3 text-[13px] leading-relaxed text-ink-secondary">
          {bot.chiefOfStaff && !canCoordinate
            ? "This bot still holds the role, but its current provider cannot contact teammates. Choose a provider that supports bot coordination."
            : bot.chiefOfStaff
              ? `This is the primary contact for ${sectionName}. It can create and coordinate specialists in this team, then combine their work into one answer.`
              : !canCoordinate
                ? "Choose a provider that supports bot coordination."
                : currentChief
                  ? `Make this bot the ${sectionName} Chief and hand the role over from ${currentChief.name}.`
                  : `Make this bot the primary contact for the ${sectionName} team.`}
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
      </div>

      <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
        <div>
          <div className="text-[15px] font-medium text-ink">Ask me before contacting other bots</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            {bot.approvePeerComms
              ? "This bot will stop and ask before it reaches out to another bot."
              : "Let this bot talk to teammates on its own, without a confirmation step."}
          </div>
          <ProposalStatus bot={bot} kind="owner" />
        </div>
        <Switch
          checked={Boolean(bot.approvePeerComms)}
          aria-label="Ask me before contacting other bots"
          disabled={!bot.approvePeerComms && !canCoordinate}
          onClick={() => patch({ approvePeerComms: !bot.approvePeerComms })}
          title={!bot.approvePeerComms && !canCoordinate ? "This model cannot contact other bots" : undefined}
          className="disabled:cursor-not-allowed"
        />
      </div>

      <div className="rounded-xl bg-card p-4">
        <div className="text-[15px] font-medium text-ink">Approval level</div>
        <div className="mt-0.5 text-[13px] text-ink-secondary">
          {draft ? "Default for the new bot's threads, routines and delegated work." : "Default for new threads, routines and delegated work. When enabling Full access, you can also apply it to every existing thread. Use Refresh permissions on a thread to apply the current level to that conversation."}
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
        {!draft && approvalMode === "full" && trustedModesAvailable && <button
          type="button" disabled={Boolean(bot.busy)}
          className="mt-3 text-[13px] text-accent hover:underline disabled:opacity-40"
          onClick={() => { setAllThreads(true); setFullAccessTarget(bot.id); }}
        >Apply Full access to all threads</button>}
        {!draft && ownerOrAdmin === true && <button
          type="button"
          className="mt-3 block text-[13px] text-accent hover:underline"
          onClick={() => setCommandAllowlistTarget({ botId: bot.id, botName: bot.name })}
        >{t("commandAllowlist.manage")}</button>}
      </div>

      {commandAllowlistTarget && <CommandAllowlistDialog
        key={commandAllowlistTarget.botId}
        {...commandAllowlistTarget}
        onClose={() => setCommandAllowlistTarget(null)}
      />}
      {!draft && <OutboundControl key={bot.id} bot={bot} onChange={(outbound) => patch({ outbound })} />}
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
      <FullAccessWarning
        open={fullAccessTarget !== null}
        allThreads={allThreads}
        onAllThreadsChange={draft ? undefined : setAllThreads}
        onCancel={() => setFullAccessTarget(null)}
        onConfirm={() => {
          const target = fullAccessTarget;
          setFullAccessTarget(null);
          if (!target) return;
          if (whenBusy) scheduleApprovalMode(target, "full", whenBusy, { confirmFullAccess: true, applyToAllThreads: allThreads });
          else dispatch({ type: "updateBot", botId: target, patch: { approvalMode: "full", confirmFullAccess: true, applyToAllThreads: allThreads } });
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

/** Sending on the person's behalf. Separate from the approval level on
 * purpose: Full access does not bypass it, so it cannot live inside that
 * selector without implying it does. Today's count comes from the harness,
 * which is the only thing that knows what actually went out. */
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
      <div className="text-[15px] font-medium text-ink">Sending on your behalf</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
        Emails, messages, posts, invites, and payments through connected apps. Reading and drafting never count.
        This applies at every approval level, including Full access.
      </div>
      <div className="mt-3 flex gap-1 rounded-lg bg-inset p-0.5">
        {(
          [
            ["ask", "Ask every time", "Every send waits for your tap."],
            ["allow", "Allow a daily amount", "Sends go out on their own, up to the cap below."],
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
            Up to
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
              aria-label="Daily outbound limit"
              className="w-20 rounded-md bg-inset px-2 py-1 text-[13px] text-ink tabular-nums outline-none focus:ring-1 focus:ring-accent"
            />
            a day
          </label>
          <span className="tabular-nums">
            {today === null ? "" : `${today} of ${policy.dailyCap} used today`}
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
