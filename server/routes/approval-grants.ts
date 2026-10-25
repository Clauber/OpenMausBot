import { approvalModeFor, isApprovalMode, type ApprovalMode } from "../../shared/approval-mode.ts";
import type { WireBot } from "../../shared/wire.ts";
import type { ModelSelection, RequestOutcome } from "../contracts.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { BotRecord, Store } from "../store.ts";
import type { UsageTrigger } from "../usage-ledger.ts";
import { PASS, type RouteHandler } from "./table.ts";

/** An approval level chosen while the bot works: it lands when the bot goes idle. In memory only. */
export interface PendingApprovalChange {
  mode: ApprovalMode;
  allThreads: boolean;
  /** Threads that were working when the change was chosen: they get it too. */
  threadIds: string[];
  /** Threads stopped for the change, continued once it lands. */
  resume: string[];
  trigger: UsageTrigger;
}

export interface ApprovalGrantRouteDeps {
  store: Pick<Store, "bot" | "tasks" | "patchBot" | "setAllThreadApprovalMode" | "taskByThread" | "messagesFor">;
  /** Set on a shared company workspace, where Full access comes only from the operator's policy. */
  hostedFullAccessRefusal: string | null;
  cloudHome: boolean;
  desktopManaged: boolean;
  operatorFullAccess: boolean;
  pendingApprovalChanges: Map<string, PendingApprovalChange>;
  applyPendingApprovalChanges(): void;
  /** The records running 1:1 turns judge their later cards by. */
  directTurnBots: { values(): Iterable<BotRecord> };
  cloudOwnerSession(auth: RequestAuth): boolean;
  canManageCommandAllowlist(auth: RequestAuth): boolean;
  supportsApprovalMode(selection: ModelSelection, mode: ApprovalMode): boolean;
  threadBusy(botId: string, threadId: string): boolean;
  interruptDirectThread(botId: string, threadId: string): Promise<void>;
  usageTriggerFor(auth: RequestAuth): UsageTrigger;
  answerRequest(
    threadId: string, instanceId: string, requestId: string, behavior: "allow", message?: string,
    decidedFor?: { id: string; name: string },
  ): Promise<RequestOutcome>;
  broadcast(payload: Record<string, unknown>): void;
  wireBot(bot: BotRecord): WireBot;
}

const CLOUD_OWNER_ONLY = "On this Cloud only its owner can change how a bot asks for approval.";

/** Security invariant: Full access over HTTP needs the operator's opt-in (OMB_OPERATOR_FULL_ACCESS=1) and the
 *  warning's acknowledgement on the request. The desktop's private approval channel does not pass through here. */
export function fullAccessHttpRefusal(operatorFullAccess: boolean, body: { confirmFullAccess?: unknown } | null | undefined): { status: 400 | 403; error: string } | null {
  if (!operatorFullAccess) return { status: 403, error: "This approval-level change can only be made from the packaged desktop app" };
  if (body?.confirmFullAccess !== true) return { status: 400, error: "Confirm the Full access warning first (confirmFullAccess)" };
  return null;
}

export function createApprovalGrantRoutes(deps: ApprovalGrantRouteDeps): RouteHandler {
  const {
    store, pendingApprovalChanges, applyPendingApprovalChanges, cloudOwnerSession, canManageCommandAllowlist, supportsApprovalMode,
    threadBusy, interruptDirectThread, usageTriggerFor, answerRequest, broadcast, wireBot,
  } = deps;
  return async ({ req, res, path, method, auth, json, readBody }) => {
    // The bot PATCH refuses a busy bot; "next-turn" lands the level when the bot goes idle, "restart" stops its running
    // 1:1 turns, lands it, and continues them. Same checks as the idle change.
    let m = path.match(/^\/api\/bots\/([\w-]+)\/approval-mode-when-busy$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      if (auth.kind === "session" && !auth.scopes.includes("admin")) {
        return json(res, 403, { error: "forbidden: changing a bot's approval level needs the admin scope" });
      }
      if (deps.cloudHome && !cloudOwnerSession(auth)) return json(res, 403, { error: CLOUD_OWNER_ONLY });
      // Security invariant: a bot curling the loopback API from a tool call must not schedule its own level.
      if (auth.kind === "loopback" && !deps.desktopManaged && !req.headers.origin) {
        return json(res, 403, { error: "Change approval levels from the app or a paired device." });
      }
      if (body?.whenBusy !== "next-turn" && body?.whenBusy !== "restart") {
        return json(res, 400, { error: "whenBusy must be next-turn or restart" });
      }
      if (!isApprovalMode(body.approvalMode)) return json(res, 400, { error: "approvalMode must be ask, edits, auto, full, or custom" });
      const mode: ApprovalMode = body.approvalMode;
      const target = store.bot(m[1]!);
      if (!target) return json(res, 404, { error: "no such bot" });
      if (target.approvalGrant) return json(res, 409, { error: "the bot's approval mode is still being confirmed" });
      const current = approvalModeFor(target);
      if (mode === "custom" || current === "custom") {
        return json(res, 403, { error: "Custom approval changes require the packaged desktop app" });
      }
      if (!supportsApprovalMode(target.modelSelection, mode)) {
        return json(res, 400, { error: "This provider does not support the selected approval level" });
      }
      // Choosing the level the bot already has only withdraws a pending change: it grants nothing.
      const withdraws = mode === current && body.applyToAllThreads !== true;
      if (mode === "full" && !withdraws && current !== "full" && deps.hostedFullAccessRefusal) {
        return json(res, 403, { error: deps.hostedFullAccessRefusal });
      }
      const fullRefusal = mode === "full" && !withdraws ? fullAccessHttpRefusal(deps.operatorFullAccess, body) : null;
      if (fullRefusal) return json(res, fullRefusal.status, { error: fullRefusal.error });
      if (mode === "auto" && target.computer === "local" && current !== "auto" && body.acknowledgeLocalAuto !== true) {
        return json(res, 400, { error: "Auto mode on this computer requires confirming the warning first (acknowledgeLocalAuto)" });
      }
      const busyThreads = store.tasks(target.id).map((task) => task.threadId).filter((threadId) => threadBusy(target.id, threadId));
      if (withdraws) {
        pendingApprovalChanges.delete(target.id);
      } else {
        pendingApprovalChanges.set(target.id, {
          mode,
          allThreads: mode === "full" && body.applyToAllThreads === true,
          threadIds: busyThreads,
          resume: body.whenBusy === "restart" ? busyThreads : [],
          trigger: usageTriggerFor(auth),
        });
        if (body.whenBusy === "restart") {
          await Promise.allSettled(busyThreads.map((threadId) => interruptDirectThread(target.id, threadId)));
        }
      }
      applyPendingApprovalChanges();
      const fresh = store.bot(target.id)!;
      broadcast({ kind: "bot", bot: wireBot(fresh) });
      return json(res, 200, { ok: true, pending: pendingApprovalChanges.has(target.id), bot: wireBot(fresh) });
    }

    // "Always allow everything" from a waiting approval card, mid-turn. Every later request in the running turn is
    // answered under Full, because the level is read at request.opened from the turn's record, which this updates.
    m = path.match(/^\/api\/bots\/([\w-]+)\/allow-everything$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      if (deps.hostedFullAccessRefusal) return json(res, 403, { error: deps.hostedFullAccessRefusal });
      if (deps.cloudHome && !cloudOwnerSession(auth)) return json(res, 403, { error: CLOUD_OWNER_ONLY });
      // Security invariant: a bot curling the loopback API must not grant itself Full access.
      if (!canManageCommandAllowlist(auth) || (auth.kind === "loopback" && !deps.desktopManaged && !req.headers.origin)) {
        return json(res, 403, { error: "Only the owner or an admin can grant Full access from the app." });
      }
      const fullRefusal = fullAccessHttpRefusal(deps.operatorFullAccess, body);
      if (fullRefusal) return json(res, fullRefusal.status, { error: fullRefusal.error });
      const target = store.bot(m[1]!);
      if (!target) return json(res, 404, { error: "no such bot" });
      if (target.approvalGrant) return json(res, 409, { error: "the bot's approval mode is still being confirmed" });
      if (approvalModeFor(target) === "custom") {
        return json(res, 403, { error: "Leaving Custom approval requires the packaged desktop app" });
      }
      if (!supportsApprovalMode(target.modelSelection, "full")) {
        return json(res, 400, { error: "This provider does not support Full access" });
      }
      store.patchBot(target.id, { approvalMode: "full", autoApprove: false });
      store.setAllThreadApprovalMode(target.id, "full");
      // A level queued for the end of the turn must not land afterwards and undo this.
      pendingApprovalChanges.delete(target.id);
      for (const live of deps.directTurnBots.values()) {
        if (live.id === target.id) { live.approvalMode = "full"; live.autoApprove = false; live.alwaysAllow = []; }
      }
      // The card's own thread may be a room's; the rest are the bot's own.
      const threadIds = new Set((store.bot(target.id)?.tasks ?? []).map((task) => task.threadId));
      if (typeof body.threadId === "string") threadIds.add(body.threadId);
      let answered = 0;
      for (const threadId of threadIds) {
        const roomThread = !store.taskByThread(target.id, threadId);
        for (const message of store.messagesFor(threadId)) {
          const card = message.card;
          if (!card?.requestId || !card.tool || card.answered || card.dismissed || card.expired) continue;
          if (card.requestType === "question" || card.questionRequest) continue;
          // Harness-owned proposals and peer grants keep their own answers.
          if (card.allowKey || card.routineRequest || card.skillRequest || card.profileRequest || card.modelRequest ||
            card.teamSetupRequest || card.teamMemoryRequest) continue;
          if (roomThread && message.from?.botId !== target.id) continue;
          const outcome = await answerRequest(threadId, target.modelSelection.instanceId, card.requestId, "allow", undefined, { id: target.id, name: target.name });
          if (outcome !== "unavailable") answered += 1;
        }
      }
      return json(res, 200, { ok: true, answered, bot: wireBot(store.bot(target.id)!) });
    }
    return PASS;
  };
}
