import { describe, expect, it } from "vitest";
import { autoReview } from "./auto-review.ts";
import { createDecider } from "./decider/index.ts";
import type { AppConfig } from "./config.ts";
const action = { tool: "GMAIL_SEND_EMAIL", args: { to: "fixture@example.com" }, topic: "send the approved update" };
const judge = (choice: string, p: number) => createDecider({ config: () => ({ decider: { enabled: true, key: "fixture-key", baseUrl: "http://127.0.0.1:1" } } as AppConfig), fetch: async () => new Response(JSON.stringify({ answers: { answer: { choice, probabilities: { [choice]: p, [choice === "ask" ? "allow" : "ask"]: 1 - p } } } })) });
describe("auto review", () => {
  it.each(["allow", "ask", "deny"] as const)("accepts a confident %s", async decision => {
    expect(await autoReview(judge(decision, 0.95), action)).toMatchObject({ decision, confidence: 0.95 });
  });
  it("turns low confidence allow and deny into ask", async () => {
    for (const choice of ["allow", "deny"]) expect(await autoReview(judge(choice, 0.55), action)).toMatchObject({ decision: "ask", confidence: 0.55, reasoning: expect.stringContaining("confidence") });
  });
  it("degrades unavailable or malformed judges to the existing policy", async () => {
    expect(await autoReview(createDecider({ config: () => ({} as AppConfig) }), action)).toBeNull();
    expect(await autoReview(judge("invalid", 1), action)).toBeNull();
  });
  it("does not judge reads", async () => expect(await autoReview(judge("deny", 1), { ...action, tool: "GMAIL_GET_MESSAGE" })).toBeNull());
  it("redacts secrets and bounds context before the existing decider client sees it", async () => {
    let state: any;
    const decider = createDecider({ config: () => ({ decider: { enabled: true, key: "fixture-key", baseUrl: "http://127.0.0.1:1" } } as AppConfig), fetch: async (_url, init) => {
      state = JSON.parse(String(init?.body)).state;
      return new Response(JSON.stringify({ answers: { answer: { choice: "ask", probabilities: { ask: 1 } } } }));
    } });
    await autoReview(decider, { ...action, args: { token: "private-fixture-value", body: "x".repeat(10_000) } });
    expect(JSON.stringify(state)).not.toContain("private-fixture-value");
    expect(state.argsSummary.length).toBeLessThanOrEqual(2000);
    expect(state.topic).toBe(action.topic);
  });
});
