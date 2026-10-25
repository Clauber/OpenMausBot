/** Routine wire shapes: the routine and run records as they ride the REST
 * snapshot and the `routine` / `routine.run` live frames. */
import type { LimitResetSchedule, LimitResetScheduleInput } from "./limit-reset.ts";
import type { RoutinePreCheck, RoutinePreCheckResult } from "./routine-precheck.ts";
import type { RoutineCronSchedule } from "./routine-schedule.ts";

export interface RoutineIntervalWindow {
  start: string;
  end: string;
}

export type RoutineSchedule =
  | RoutineCronSchedule
  | LimitResetSchedule
  | { type: "once"; at: number }
  | { type: "daily"; time: string; weekdays: number[] }
  | {
    type: "interval";
    everyMinutes: number;
    anchorAt: number;
    /** Local weekdays (Sunday = 0). Missing means every day. */
    weekdays?: number[];
    /** Local wall-clock window. Missing means all day. */
    window?: RoutineIntervalWindow;
    /** Inclusive epoch-millisecond cutoff. Missing means never. */
    endsAt?: number;
  };

export type RoutineScheduleInput =
  | Extract<RoutineSchedule, { type: "once" | "daily" | "cron" }>
  | LimitResetScheduleInput
  | {
    type: "interval";
    everyMinutes: number;
    anchorAt: number;
    /** `null` explicitly restores the every-day default on updates. */
    weekdays?: number[] | null;
    /** `null` explicitly restores the all-day default on updates. */
    window?: RoutineIntervalWindow | null;
    /** `null` explicitly removes an existing end date on updates. */
    endsAt?: number | null;
  };

export type RoutineRunOn = "maus" | "cloud";

export type RoutineTarget = "bot" | "room-goal";
export type RoutineGoalStatus =
  | "completed"
  | "needs-input"
  | "blocked"
  | "limit-reached"
  | "paused"
  | "stopped"
  | "failed";

export interface RoutineContextAttachment {
  id: string;
  kind: "file" | "image";
  name: string;
  path: string;
  size: number;
}

/** How a routine's runs execute. `llm` is a bot turn every run (the
 * default). `script` runs an approved Python script and reports its output
 * with no model involved. `script-jev` runs the script, then asks the
 * decision model whether the output needs the bot; only then does a turn
 * start, with the output in hand. */
export type RoutineExecutionMode = "llm" | "script" | "script-jev";

/** A reviewer model's verdict on a routine, written after it is created or
 * its instructions change. A script never runs until a person approves it:
 * `proposed` runs as `llm`. A plan whose `promptHash` no longer matches the
 * routine's instructions is stale and ignored. */
export interface RoutineExecutionPlan {
  mode: RoutineExecutionMode;
  status: "proposed" | "approved";
  /** Why the reviewer chose this mode, one or two sentences. */
  rationale: string;
  /** Python 3 source; present for `script` and `script-jev`. */
  script?: string;
  /** For `script-jev`: when the output needs the bot, in plain words. */
  escalateWhen?: string;
  /** SHA-256 of the routine instructions this plan was written for. */
  promptHash: string;
  /** SHA-256 of `script`; approval names it so an edit cannot ride along. */
  scriptHash?: string;
  reviewer: string;
  reviewedAt: number;
  approvedAt?: number;
}

/** What actually ran: the script alone, the script then the bot (the
 * decision model asked for it, or could not answer), or the bot alone. */
export type RoutineRunExecutor = "script" | "script-llm" | "llm";

export type RoutineRunTrigger = "schedule" | "manual" | "webhook" | "startup";

/** A check a routine runs on each tick before any AI turn, in plain code: `calendar` reads the next 36 hours, `mail`
 * new inbox mail since the last check, `runs` other routines' finished runs. Nothing new means no AI turn. */
export type RoutineCheck = "calendar" | "mail" | "runs";
export const ROUTINE_CHECKS: readonly RoutineCheck[] = ["calendar", "mail", "runs"];

/** What a routine's runs may do. `read-and-draft`: read Gmail and Google Calendar and write reply drafts; every other
 * tool is refused outright, never turned into a card. Missing means the bot's own level. */
export type RoutineAccess = "read-and-draft";

/** Where a routine's results go. `brief`: they become rows of the main agent's brief, not chat lines of their own. */
export type RoutineDelivery = "brief";

/** What a finished run left in the chat it reports to: nothing, because it
 * found nothing to tell; a report waiting for a turn there to end; or the bot
 * message it wrote. */
export type RoutineRunReport =
  | { state: "quiet" }
  | { state: "pending" }
  | { state: "posted"; threadId: string; messageId: string };

export type RoutineRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "missed"
  | "skipped";

/** Why a run started a second time by itself: its engine stalled, Legion
 * restarted while it ran, the provider rate-limited it or failed for a moment,
 * or it waited for its engine's usage limit to reset. A run gets one. */
export type RoutineRetryCause = "stalled" | "restarted" | "rate_limited" | "provider" | "usage_limit";

/** The statuses both failure indicators count: a run that went wrong and has
 * not been acknowledged. */
export const ROUTINE_PROBLEM_STATUSES: readonly RoutineRunStatus[] = ["failed", "missed"];

export function isRoutineProblemRun(run: { status: RoutineRunStatus }): boolean {
  return ROUTINE_PROBLEM_STATUSES.includes(run.status);
}

/** The logs view's status filter: every run, the composite problem set the
 * indicators count, or one exact status. */
export type RoutineRunStatusFilter = "all" | "problems" | RoutineRunStatus;

export interface GithubRoutineTrigger {
  repo: string;
  events: string[];
  /** Applies to events with an action; merged matches closed PRs with merged=true. */
  actions?: string[];
}

export interface GithubRoutineTriggerInput extends GithubRoutineTrigger {
  /** Required at creation. Omission on update preserves the private secret. */
  secret?: string;
}

export interface Routine {
  id: string;
  name: string;
  prompt: string;
  preCheck?: RoutinePreCheck;
  target: RoutineTarget;
  botId: string;
  groupId?: string;
  runOn: RoutineRunOn;
  enabled: boolean;
  schedule: RoutineSchedule;
  /** When set, GitHub deliveries replace timer dispatch. */
  github?: GithubRoutineTrigger;
  durationMinutes: number;
  /** Optional wall-clock safety limit. Missing means the run is unlimited. */
  timeoutMinutes?: number;
  overlap?: "skip" | "queue";
  /** Each run starts with the previous run's report. */
  continuity?: boolean;
  /** Also run once each time Legion starts. */
  runOnStartup?: boolean;
  checks?: RoutineCheck[];
  access?: RoutineAccess;
  deliver?: RoutineDelivery;
  /** When its checks last read everything and found nothing for the AI. */
  checkedAt?: number;
  /** A plain sentence while its checks cannot read an app, so a failed read never looks like nothing new. */
  checkTrouble?: string;
  /** The next time its checks have something to do on time (a reminder, meeting prep): only this may keep the
   * computer awake or wake a sleeping Cloud. */
  wakeAt?: number;
  skippedRuns?: number;
  lastSkippedAt?: number;
  failureStreak?: number;
  /** Runs that finished in the last seven days, and how many of them completed. */
  weekRuns?: { ok: number; total: number };
  /** A plain sentence when the routine names a path that cannot exist on the computer that runs it. */
  warning?: string;
  attachments?: RoutineContextAttachment[];
  sourceThreadId?: string;
  resultsThreadId?: string;
  execution?: RoutineExecutionPlan;
  /** A reviewer is looking at this routine right now. */
  reviewing?: boolean;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface RoutineRun {
  id: string;
  routineId: string;
  routineName: string;
  prompt?: string;
  preCheck?: RoutinePreCheck;
  preCheckResult?: RoutinePreCheckResult;
  durationMinutes?: number;
  timeoutMinutes?: number;
  attachments?: RoutineContextAttachment[];
  target: RoutineTarget;
  goalStatus?: RoutineGoalStatus;
  botId: string;
  groupId?: string;
  runOn: RoutineRunOn;
  scheduledFor: number;
  status: RoutineRunStatus;
  manual: boolean;
  triggerSource?: RoutineRunTrigger;
  /** "app": a connected-app event started it; triggerSource is then "webhook" (an outside event). */
  eventSource?: "app";
  webhookId?: string;
  deliveryId?: string;
  /** Room task created for a team-goal run. */
  executionThreadId?: string;
  sourceThreadId?: string;
  resultsThreadId?: string;
  threadId?: string;
  startedAt?: number;
  finishedAt?: number;
  output?: string;
  error?: string;
  /** Set when the run used its one automatic second start, and why. */
  retried?: RoutineRetryCause;
  /** Concise, redacted question or approval reason while status is waiting,
   * or why a queued run starts later. */
  attention?: string;
  executor?: RoutineRunExecutor;
  /** The decision model's probability that the script output needed the bot. */
  escalationP?: number;
  cost?: number | null;
  denials?: string[];
  report?: RoutineRunReport;
  access?: RoutineAccess;
  deliver?: RoutineDelivery;
  /** The items its routine's checks handed this run, so they are kept or released once it ends. */
  checkKey?: string;
  createdAt: number;
  seenAt?: number;
}

export interface RoutineInput {
  name: string;
  prompt: string;
  preCheck?: RoutinePreCheck | null;
  target?: RoutineTarget;
  botId: string;
  groupId?: string | null;
  runOn?: RoutineRunOn;
  enabled?: boolean;
  schedule: RoutineScheduleInput;
  /** null switches back to the saved schedule. */
  github?: GithubRoutineTriggerInput | null;
  durationMinutes?: number;
  /** `null` explicitly removes the limit; omission preserves it on updates. */
  timeoutMinutes?: number | null;
  overlap?: "skip" | "queue";
  /** Each run starts with the previous run's report. */
  continuity?: boolean;
  runOnStartup?: boolean;
  /** `null` explicitly removes them on updates; omission preserves them. */
  checks?: RoutineCheck[] | null;
  access?: RoutineAccess | null;
  deliver?: RoutineDelivery | null;
  attachments?: RoutineContextAttachment[];
  /** Omission preserves routing; null creates a new dedicated results task;
   * ROUTINE_OWN_RESULTS_THREAD opens (or keeps) one named after the routine;
   * ROUTINE_DEFAULT_RESULTS_THREAD returns to the default destination. */
  resultsThreadId?: string | null;
}

/** Input-only `resultsThreadId`: open (or keep) a conversation named after
 * the routine and post every run's result there, out of the main thread. */
export const ROUTINE_OWN_RESULTS_THREAD = "own-thread";

/** Input-only `resultsThreadId`: forget the chosen destination, so runs report
 * where they did by default (the chat that set the routine up). */
export const ROUTINE_DEFAULT_RESULTS_THREAD = "default";
