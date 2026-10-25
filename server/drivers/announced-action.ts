// Some engines answer a work prompt by announcing the next step — "Checking
// the page first —", "Now let me run the build." — and end the turn without
// doing it. The remedy both runtimes share is one automatic continuation
// nudge per turn: this predicate decides when one applies, and each runtime
// phrases its own nudge (chat-completions must push the model back into a
// tool call; ACP agents get a plain continuation prompt).

export function announcesAction(text: string): boolean {
  const reply = text.trim();
  if (!reply || reply.length > 4_000 || reply.includes("?")) return false;
  if (reply.length > 400) {
    const tail = reply.split(/\n\s*\n/).at(-1)!.trim();
    return tail.length <= 400 && /^(?:let me|i['\u2019]ll|i will|i(?:['\u2019]m| am) going to)\s+(?:now\s+)?(?:execute|send|type|press|launch|open|check|inspect|read|fetch|run|create|write|verify)\b/i.test(tail);
  }
  return /^(?:checking|let me(?! know\b)|i'll|i will|i'm going to|i am going to|opening|pulling|looking|searching|navigating|reading|fetching|loading|now (?:i'll|let me|opening|checking|pulling|reading)|next,? (?:i'll|i will|i'm going to|i am going to|let me|we'll|we will))\b/i.test(reply) ||
    /^i(?:['\u2019]m| am)\b[^.!?\n]*\band (?:i )?will\s+(?:launch|open|check|pull|look|search|navigate|read|fetch|load|run|inspect)\b/i.test(reply);
}

export const NUDGE_ANNOUNCED_ACTION = "You said what you would do next but called no tool. Use your tools for only the remaining work, or reply with verified results if nothing is left to do. Never repeat an operation that succeeded, was denied, or may already have taken effect; inspect its state instead. Do not retry a destructive operation.";

/** The agent-harness nudge (Claude, Codex, ACP): a follow-up message inside
 *  the same turn that both continues real work and lets a finished agent
 *  bow out with its final answer instead of inventing more. */
export const CONTINUATION_NUDGE = "You announced your next step but ended the turn before doing it. Continue now with your tools. If the work is actually finished, reply with your final answer instead.";
