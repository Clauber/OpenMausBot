import type { Decider } from "./index.ts";
import { validPreCheckItems } from "../routine-precheck.ts";
import { RELAY_MAX_STATE_BYTES } from "./relay.ts";
import { ROUTINE_WAKE } from "./jobs.ts";
import type { RoutinePreCheckItem } from "../../shared/routine-precheck.ts";

export async function decideRoutineWake(
  decider: Pick<Decider, "choose">,
  instructions: string,
  items: readonly RoutinePreCheckItem[],
  signal?: AbortSignal,
): Promise<{ skip: boolean; reason: string; probability?: number }> {
  try {
    const state = { instructions, items };
    // Never classify a partial instruction or item set as noise.
    if (!instructions.trim() || !items.length || !validPreCheckItems(items) || Buffer.byteLength(JSON.stringify(state)) > RELAY_MAX_STATE_BYTES) return { skip: false, reason: "state_limit" };
    const result = await decider.choose("routineWake", state,
      { instructions: ROUTINE_WAKE.instructions, options: { ...ROUTINE_WAKE.options! } },
      { timeoutMs: ROUTINE_WAKE.timeoutMs, signal });
    if (!result.ok) return { skip: false, reason: result.reason };
    if (result.answers.type !== "choice") return { skip: false, reason: "malformed" };
    const { choice, pTop } = result.answers;
    if (!["needs_bot", "noise_only"].includes(choice) || !Number.isFinite(pTop) || pTop < 0 || pTop > 1) return { skip: false, reason: "malformed" };
    return { skip: choice === "noise_only" && pTop >= 0.7, reason: choice === "noise_only" && pTop >= 0.7 ? "noise_only" : "needs_bot", probability: pTop };
  } catch { return { skip: false, reason: "failure" }; }
}
