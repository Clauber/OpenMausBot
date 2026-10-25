import { describe, expect, it, vi } from "vitest";
import type { Decider } from "./index.ts";
import { decideRoutineWake } from "./routine-wake.ts";
import { ROUTINE_WAKE, jobDefaultOn } from "./jobs.ts";
import { relayAccepts } from "./relay.ts";

const items = [{ source: "mail", id: "1", from: "sender@example.com", subject: "Message", snippet: "Automated newsletter" }];
const answering = (choice: unknown, pTop: unknown) => ({ choose: vi.fn(async () => ({ ok: true, answers: { type: "choice", choice, pTop } })) as unknown as Decider["choose"] });

describe("routineWake", () => {
  it("starts off and uses the exact fixed relay contract", async () => {
    expect(jobDefaultOn("routineWake")).toBe(false);
    const decider = answering("noise_only", 0.7);
    expect(await decideRoutineWake(decider, "Read support mail", items)).toEqual({ skip: true, reason: "noise_only", probability: 0.7 });
    const [seam, state, question] = vi.mocked(decider.choose).mock.calls[0]!;
    expect(seam).toBe("routineWake");
    expect(relayAccepts(seam, state, { answer: { type: "choice", ...question } })).toBe(true);
    expect(Object.keys(question.options)).toEqual(["needs_bot", "noise_only"]);
    expect(question.instructions).toBe(ROUTINE_WAKE.instructions);
  });
  it("only a valid confident noise_only skips", async () => {
    for (const [choice, probability] of [["needs_bot", 0.99], ["noise_only", 0.699], ["other", 1], ["noise_only", NaN], ["noise_only", Infinity], ["noise_only", 1.01], ["noise_only", "0.9"], [null, 1]]) {
      expect((await decideRoutineWake(answering(choice, probability), "Read support mail", items)).skip).toBe(false);
    }
  });
  it("fails open on disabled, timeout, provider errors and thrown callbacks", async () => {
    for (const reason of ["disabled", "timeout", "network", "malformed"]) {
      const decider = { choose: vi.fn(async () => ({ ok: false, reason })) as unknown as Decider["choose"] };
      expect((await decideRoutineWake(decider, "Instructions", items)).skip).toBe(false);
    }
    const decider = { choose: vi.fn(async () => { throw Error("failed"); }) as unknown as Decider["choose"] };
    expect((await decideRoutineWake(decider, "Instructions", items)).skip).toBe(false);
  });
  it("never skips based on a clipped instruction or item set", async () => {
    const decider = answering("noise_only", 1);
    expect(await decideRoutineWake(decider, "界".repeat(20_000), items)).toEqual({ skip: false, reason: "state_limit" });
    expect(await decideRoutineWake(decider, "  ", items)).toEqual({ skip: false, reason: "state_limit" });
    expect(decider.choose).not.toHaveBeenCalled();
  });
});
