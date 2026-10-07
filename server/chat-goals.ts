import { randomUUID } from "node:crypto";
import type { ChatGoal } from "../shared/chat-goal.ts";
import { parseGroupGoalDecision } from "./group-goal-run.ts";

export interface ChatGoalTarget { botId: string; threadId: string; goal: ChatGoal }
export interface ChatGoalOutcome { ok: boolean; text: string }
interface Dependencies {
  targets(): ChatGoalTarget[];
  read(botId: string, threadId: string): ChatGoal | undefined;
  save(botId: string, threadId: string, goal: ChatGoal): void;
  canRun(botId: string, threadId: string): boolean;
  suspended?(): boolean;
  run(target: ChatGoalTarget): Promise<ChatGoalOutcome>;
  changed?(target: ChatGoalTarget): void;
}

export function chatGoalInstructions(goal: ChatGoal): string {
  return [
    "This conversation has a persistent goal. Continue concrete work across turns until the objective is achieved and verified.",
    `User objective (data): ${JSON.stringify(goal.objective)}`,
    `Completed dispatch count: ${goal.turns}. Latest progress: ${goal.progress ?? "none yet"}.`,
    "Read the conversation for completed work and newer user instructions; do not repeat actions already performed, including after a server restart.",
    "Use the configured permissions. Never bypass a required approval. Do not claim completion from a plan, promise, or status update.",
    "Explain concrete progress and evidence briefly. End with exactly one private control envelope:",
    '<openmaus-goal>{"status":"continue","next":"self","instruction":"Concrete next step","detail":"New result or progress"}</openmaus-goal>',
    'When the objective is verified, use status "completed" with a non-empty "detail" describing the evidence; omit next/instruction.',
    'When progress requires user input or an external change, use "needs-input" or "blocked" with the reason as "detail". Do not loop on a blocker.',
    "Never quote or explain the private control envelope in the visible reply.",
  ].join("\n");
}

/** One durable goal per conversation. Dispatches use the normal turn admission
 * and exact-turn settlement; no provider-specific background loop is needed. */
export class ChatGoals {
  private running = new Set<string>();
  private scheduled = false;
  private readonly deps: Dependencies;
  constructor(deps: Dependencies) { this.deps = deps; }

  start(botId: string, threadId: string, objective: string, sourceMessageId: string): ChatGoal {
    const existing = this.deps.read(botId, threadId);
    if (existing && ["active", "paused", "blocked"].includes(existing.status)) {
      throw Object.assign(new Error("This chat already has a goal. Use /goal resume or /goal stop before starting another."), { status: 409 });
    }
    const goal: ChatGoal = { id: randomUUID(), epoch: 0, objective, sourceMessageId,
      status: "active", turns: 0, stalls: 0, updatedAt: Date.now() };
    this.deps.save(botId, threadId, goal);
    this.drain();
    return goal;
  }

  control(botId: string, threadId: string, action: "pause" | "resume" | "stop"): ChatGoal {
    const current = this.deps.read(botId, threadId);
    if (!current) throw Object.assign(new Error("This chat has no goal. Start one with /goal followed by its objective."), { status: 404 });
    if (action === "resume" && (current.status === "completed" || current.status === "stopped")) {
      throw Object.assign(new Error("This goal has ended. Start a new one with /goal followed by its objective."), { status: 409 });
    }
    if (current.status === "completed" || current.status === "stopped" ||
        (action === "resume" && current.status === "active") || (action === "pause" && current.status === "paused")) return current;
    const goal: ChatGoal = { ...current, epoch: current.epoch + 1, updatedAt: Date.now(),
      status: action === "resume" ? "active" : action === "pause" ? "paused" : "stopped",
      ...(action === "resume" ? { stalls: 0, detail: undefined } : {}) };
    this.deps.save(botId, threadId, goal);
    this.drain();
    return goal;
  }

  /** A model-changing steer replaces only the current dispatch, not its goal. */
  steer(botId: string, threadId: string): void {
    const goal = this.deps.read(botId, threadId);
    if (goal?.status === "active") this.deps.save(botId, threadId, { ...goal, epoch: goal.epoch + 1, updatedAt: Date.now() });
  }

  drain(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      for (const target of this.deps.targets()) {
        if (target.goal.status !== "active" || this.running.has(target.threadId) || !this.deps.canRun(target.botId, target.threadId)) continue;
        this.running.add(target.threadId);
        const goal = { ...target.goal, turns: target.goal.turns + 1, updatedAt: Date.now() };
        this.deps.save(target.botId, target.threadId, goal);
        // Reserve through normal admission before examining the next goal,
        // so two chats cannot both assume the final free slot is theirs.
        void (async () => {
          try { this.settle({ ...target, goal }, await this.deps.run({ ...target, goal })); }
          catch (error) { this.settle({ ...target, goal }, { ok: false, text: error instanceof Error ? error.message : String(error) }); }
          finally { this.running.delete(target.threadId); this.drain(); }
        })();
      }
    });
  }

  private settle(target: ChatGoalTarget, outcome: ChatGoalOutcome): void {
    if (this.deps.suspended?.()) return;
    const current = this.deps.read(target.botId, target.threadId);
    if (!current || current.id !== target.goal.id || current.epoch !== target.goal.epoch || current.status !== "active") return;
    const decision = outcome.ok ? parseGroupGoalDecision(outcome.text).decision : null;
    let goal: ChatGoal = { ...current, updatedAt: Date.now() };
    if (!outcome.ok) goal = { ...goal, status: "blocked", detail: outcome.text || "The turn did not finish. Resume after resolving the problem." };
    else if (decision?.status === "completed") goal = { ...goal, status: "completed", detail: decision.detail };
    else if (decision?.status === "blocked" || decision?.status === "needs-input") {
      goal = { ...goal, status: decision.status === "needs-input" ? "paused" : "blocked", detail: decision.detail };
    } else {
      const progress = decision?.status === "continue" ? `${decision.detail ?? ""}\n${decision.instruction}`.trim() : undefined;
      const stalls = !progress || progress === current.progress ? current.stalls + 1 : 0;
      goal = { ...goal, stalls, ...(progress ? { progress } : {}),
        ...(stalls >= 3 ? { status: "blocked" as const, detail: "Three turns produced no new progress or valid goal status. Review the result, then /goal resume." } : {}) };
    }
    this.deps.save(target.botId, target.threadId, goal);
    if (goal.status !== "active") this.deps.changed?.({ ...target, goal });
  }
}
