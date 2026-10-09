// Some engines answer a work prompt by announcing the next step — "Checking
// the page first —", "Now let me run the build." — and end the turn without
// doing it. The remedy both runtimes share is one automatic continuation
// nudge per turn: this predicate decides when one applies, and each runtime
// phrases its own nudge (chat-completions must push the model back into a
// tool call; ACP agents get a plain continuation prompt).

/** A short reply that only announces a next step, with nothing to answer. */
export function announcesAction(text: string): boolean {
  const reply = text.trim();
  if (!reply || reply.length > 400 || reply.includes("?")) return false;
  return /^(?:checking|let me|i'll|i will|i'm going to|i am going to|opening|pulling|looking|searching|navigating|reading|fetching|loading|now (?:i'll|let me|opening|checking|pulling|reading)|next,? (?:i'll|i will|i'm going to|i am going to|let me|we'll|we will))\b/i.test(reply);
}

export const NUDGE_ANNOUNCED_ACTION = "You said what you would do next but called no tool. Do it now with your tools, or reply with your final answer if nothing is left to do.";

/** The agent-harness nudge (Claude, Codex, ACP): a follow-up message inside
 *  the same turn that both continues real work and lets a finished agent
 *  bow out with its final answer instead of inventing more. */
export const CONTINUATION_NUDGE = "You announced your next step but ended the turn before doing it. Continue now with your tools. If the work is actually finished, reply with your final answer instead.";
