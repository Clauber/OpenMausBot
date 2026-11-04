import type { Message } from "@/state/store";
import { isToolStep, turnDurations } from "./activity-runs";

export interface ChatTurnActivity {
  steps: Message[];
  digestMessage: Message | undefined;
  durationMs: number | undefined;
}

export function consolidateTurnActivity(messages: Message[]) {
  const turns = new Map<string, Message[]>();
  for (const message of messages) {
    const turnId = message.digest?.turnId ?? message.turnId;
    if (!turnId) continue;
    const rows = turns.get(turnId) ?? [];
    rows.push(message);
    turns.set(turnId, rows);
  }
  const durations = turnDurations(messages);
  const byAnswerId = new Map<string, ChatTurnActivity>();
  const hiddenIds = new Set<string>();
  for (const rows of turns.values()) {
    const digestMessage = rows.findLast((message) => message.kind === "digest" && message.digest);
    const answer = rows.findLast((message) => message.role === "bot" && message.kind === "text" && (message.turnTerminal || digestMessage));
    if (!answer) continue;
    const steps = rows.filter(isToolStep);
    if (!steps.length && !digestMessage) continue;
    byAnswerId.set(answer.id, { steps, digestMessage, durationMs: digestMessage?.digest?.durationMs ?? durations.get(answer.id) });
    for (const message of rows) {
      if (isToolStep(message) || message.kind === "digest") hiddenIds.add(message.id);
    }
  }
  return { messages: messages.filter((message) => !hiddenIds.has(message.id)), byAnswerId };
}
