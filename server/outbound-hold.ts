import type { RuleVerdict } from "./approval-rules.ts";
import type { AutoReviewResult } from "./auto-review.ts";
import type { ConnectorCall } from "../shared/outbound.ts";
import { DEFAULT_OUTBOUND_POLICY } from "../shared/outbound.ts";
import type { Notification } from "../shared/notification.ts";
import { HELD_NOTE } from "./auto-approve.ts";
import { appendDecision } from "./decision-log.ts";
import { buildNotification } from "./notify.ts";
import type { OutboundCounts } from "./outbound-counts.ts";
import type { OutboundRequestService } from "./outbound-requests.ts";
import { outboundCard } from "./outbound-requests.ts";
import type { BotRecord, GroupRecord, Store } from "./store.ts";

/** How long a "Send on your behalf?" card waits on the person before it times out. */
export const OUTBOUND_HOLD_MS = 9 * 60_000;

/** The bot fields the hold reads. */
export type OutboundHoldBot = Pick<BotRecord, "id" | "name" | "color" | "outbound" | "avatarUrl" | "notifications">;

export interface OutboundHoldDeps {
  store: Pick<Store, "appendMessage" | "bot" | "messagesFor" | "patchMessage" | "setActivity" | "setTaskActivity" | "taskByThread">;
  dataDir: string;
  outboundRequests: OutboundRequestService;
  outboundCounts: OutboundCounts;
  /** How long a "Send on your behalf?" card waits before it times out. */
  holdMs: number;
  connectorThread: (botId: string, threadId: string) => { group?: GroupRecord } | null;
  activeGroupTurnForBot: (botId: string) => { threadId: string } | null;
  notify: (notification: Notification | null) => void;
}

export type OutboundHoldAnswer = { ok: true; approved: boolean } | { ok: false; text: string };

export interface OutboundHold {
  /** Below Full access, a send waits on the "Send on your behalf?" card or spends the daily allowance. */
  hold(input: { bot: OutboundHoldBot; threadId: string; tool: string; calls: ConnectorCall[]; opaque: boolean; fullAccess: boolean; active: () => boolean; approval?: { rule: RuleVerdict; review: AutoReviewResult | null; effectKey?: string; outbound: boolean } }): Promise<OutboundHoldAnswer>;
  /** At dispatch time: Full access logs auto-approved; "allow" reserves against the cap; otherwise the hold must have been approved. Throws the refusal text. */
  reserve(input: { bot: OutboundHoldBot; threadId: string; tool: string; calls: ConnectorCall[]; opaque: boolean; fullAccess: boolean; approved: boolean; rule?: RuleVerdict; effectKey?: string }): void;
}

export function createOutboundHold(deps: OutboundHoldDeps): OutboundHold {
  const { store, outboundRequests, outboundCounts, connectorThread, activeGroupTurnForBot, notify } = deps;
  const DATA_DIR = deps.dataDir;
  const { holdMs } = deps;

  return {
    async hold({ bot: currentSender, threadId, tool: outboundTool, calls: outboundCalls, opaque, fullAccess, active, approval }) {
      const refuseOutbound = (text: string): OutboundHoldAnswer => ({ ok: false, text });
      const rule = approval?.rule;
      const review = approval?.review;
      const key = approval?.effectKey;
      const requiresCard = rule?.decision === "require_approval" || review?.decision === "ask" ||
        ((approval?.outbound ?? true) && !fullAccess && (opaque || (currentSender.outbound ?? DEFAULT_OUTBOUND_POLICY).policy === "ask") && rule?.decision !== "always_allow");
      if (fullAccess && !requiresCard) return { ok: true, approved: false };
      const policy = currentSender.outbound ?? DEFAULT_OUTBOUND_POLICY;
      const { app, calls, summary } = outboundCard(outboundCalls);
      const capNote = (count: number) =>
        `Legion did not send this. ${currentSender.name} has reached its daily limit of ${count} outbound action${count === 1 ? "" : "s"}. Ask the user to raise the limit under the bot's Permissions before trying again.`;
      if (policy.policy === "allow" && !opaque) {
        const today = outboundCounts.today(currentSender.id);
        if (today + outboundCalls.length > policy.dailyCap) {
          appendDecision(DATA_DIR, {
            threadId, botId: currentSender.id, botName: currentSender.name,
            tool: outboundTool, summary, decision: "auto-denied", source: "outbound", rule: `daily-cap:${policy.dailyCap}`,
          });
          return refuseOutbound(capNote(policy.dailyCap));
        }
      }
      if (requiresCard) {
        const owner = connectorThread(currentSender.id, threadId);
        const held = outboundRequests.open({ botId: currentSender.id, threadId, tool: outboundTool, timeoutMs: holdMs });
        const card = store.appendMessage(threadId, {
          role: "bot",
          kind: "options",
          ...(owner?.group ? { from: { botId: currentSender.id, name: currentSender.name, color: currentSender.color } } : {}),
          card: {
            title: approval?.outbound === false ? "Approval needed" : "Send on your behalf?",
            effectKey: key, autoReview: review ?? undefined,
            subtitle: summary,
            options: ["Allow", "Deny"],
            requestId: held.requestId,
            tool: outboundTool,
            held: rule?.decision === "require_approval" ? "An approval rule requires your confirmation." : review?.decision === "ask" ? review.reasoning : HELD_NOTE["approval.held.outbound"],
            heldCode: "approval.held.outbound",
            outboundRequest: { tool: outboundTool, app, calls },
          },
        });
        appendDecision(DATA_DIR, {
          threadId, requestId: held.requestId, botId: currentSender.id, botName: currentSender.name,
          tool: outboundTool, summary, effectKey: key, decision: "card-shown", source: rule?.decision ? "approval-rules" : review?.decision === "ask" ? "auto-review" : "outbound", rule: rule?.rule,
        });
        if (owner?.group) {
          if (activeGroupTurnForBot(currentSender.id)?.threadId === threadId) store.setActivity(currentSender.id, "waiting-on-you");
        } else if (store.taskByThread(currentSender.id, threadId)?.busy) {
          store.setTaskActivity(currentSender.id, threadId, "waiting-on-you");
        }
        notify(buildNotification("approval", currentSender, threadId, summary, { avatarUrl: currentSender.avatarUrl }));
        const answer = await held.answer;
        outboundRequests.forget(held.requestId);
        if (active()) {
          const waiting = store.bot(currentSender.id);
          if (owner?.group) {
            if (activeGroupTurnForBot(currentSender.id)?.threadId === threadId && waiting?.activity === "waiting-on-you") store.setActivity(waiting.id, "working");
          } else if (store.taskByThread(currentSender.id, threadId)?.activity === "waiting-on-you") {
            store.setTaskActivity(currentSender.id, threadId, "working");
          }
        }
        if (answer !== "allow") {
          if (answer === "timeout") {
            const stale = store.messagesFor(threadId).find((message) => message.id === card.id);
            if (stale?.card && !stale.card.answered) {
              store.patchMessage(threadId, stale.id, { card: { ...stale.card, answered: "unavailable", dismissed: true } });
            }
          }
          return refuseOutbound(
            answer === "timeout"
              ? "Legion did not send this: nobody answered the approval in time. Ask the user before trying again."
              : "Legion did not send this: the user declined. Do not retry it; ask the user what they would like instead.",
          );
        }
        return { ok: true, approved: true };
      }
      return { ok: true, approved: false };
    },
    reserve({ bot: fresh, threadId, tool: outboundTool, calls: outboundCalls, opaque, fullAccess, approved: outboundApproved, rule, effectKey }) {
      const refuseDispatch: (text: string) => never = (text) => {
        throw new Error(text);
      };
      if (fullAccess) {
        appendDecision(DATA_DIR, { threadId, botId: fresh.id, botName: fresh.name,
          tool: outboundTool, effectKey, decision: "auto-approved", source: "outbound", rule: "full-access" });
      } else {
        const policy = fresh.outbound ?? DEFAULT_OUTBOUND_POLICY;
        if (policy.policy === "ask" && !outboundApproved && rule?.decision !== "always_allow") refuseDispatch("The outbound policy changed. Ask for approval again before sending.");
        {
          let reserved: number | null;
          try { reserved = outboundCounts.reserve(fresh.id, outboundCalls.length, policy.policy === "allow" && !opaque ? policy.dailyCap : Number.MAX_SAFE_INTEGER); }
          catch { refuseDispatch("The daily allowance could not be saved. Nothing was sent."); }
          if (reserved === null) refuseDispatch("This bot has reached its daily outbound limit. Nothing was sent.");
          appendDecision(DATA_DIR, { threadId, botId: fresh.id, botName: fresh.name,
            tool: outboundTool, effectKey, decision: outboundApproved ? "user-approved" : "auto-approved", source: rule?.decision ? "approval-rules" : "outbound", rule: `${rule?.rule ?? "outbound"};daily-allowance:${reserved}/${policy.dailyCap}` });
        }
      }
    },
  };
}
