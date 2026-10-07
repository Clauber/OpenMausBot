import { readRunningTurns, retireRunningTurn, saveRunningTurn, type RunningTurn } from "./message-db.ts";

export function restartNudge(turn: RunningTurn): string {
  return `LEGION's service went down while this conversation was running (dispatch started ${new Date(turn.startedAt).toISOString()}). The service is back up now. Continue from where the work stopped, using the conversation and existing workspace state. The previous turn may have already performed actions even if their results were not recorded. Inspect current state before repeating tools, writes, messages, purchases, deployments, or other side effects. Do not start the task over. Follow newer user instructions and all current permissions; stop for any required approval. If the work already finished, verify and report the result.`;
}

/** The startup snapshot is distinct from this process's live dispatches.
 * A replacement atomically takes ownership of the same durable thread row. */
export class TurnRecovery {
  readonly pending = new Map(readRunningTurns().map(turn => [turn.threadId, turn]));
  private attempted = new Set<string>();
  private scheduled = false;

  admit(turn: RunningTurn): string {
    const previous = this.pending.get(turn.threadId);
    saveRunningTurn(turn);
    this.pending.delete(turn.threadId);
    this.attempted.delete(turn.threadId);
    return previous ? restartNudge(previous) : "";
  }

  finish(threadId: string, generation: string): void { retireRunningTurn(threadId, generation); }

  cancel(threadId: string): void {
    retireRunningTurn(threadId);
    this.pending.delete(threadId);
    this.attempted.delete(threadId);
  }

  drain(dispatch: (turn: RunningTurn) => boolean | Promise<boolean>, failed: (turn: RunningTurn, error: unknown) => void): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      for (const turn of this.pending.values()) {
        if (this.attempted.has(turn.threadId)) continue;
        this.attempted.add(turn.threadId);
        // Dispatch begins synchronously so the ordinary capacity gate is
        // reserved before examining another conversation.
        try {
          void Promise.resolve(dispatch(turn)).then(started => {
            if (!started) this.attempted.delete(turn.threadId);
          }).catch(error => failed(turn, error));
        } catch (error) { failed(turn, error); }
      }
    });
  }
}
