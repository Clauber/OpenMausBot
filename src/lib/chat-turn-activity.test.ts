import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { consolidateTurnActivity } from "./chat-turn-activity";

const ask: Message = { id: "ask", role: "user", kind: "text", at: 1_000, text: "Find the file" };
const step: Message = { id: "step", role: "bot", kind: "activity", at: 1_200, turnId: "turn", tool: { name: "Read", ok: false, output: "Not found" } };
const answer: Message = { id: "answer", role: "bot", kind: "text", at: 2_000, turnId: "turn", turnTerminal: true, text: "The file is missing." };
const digest: Message = { id: "digest", role: "bot", kind: "digest", at: 2_050, turnId: "turn", digest: { turnId: "turn", botId: "bot", threadId: "thread", at: 2_050, durationMs: 639, reply: "The file is missing.", tools: [{ name: "Read", count: 1, failed: 1 }], memory: [], hookCoverage: "preview" } };

describe("turn activity association", () => {
  it("uses the server duration and preserves narration and product notices", () => {
    const narration: Message = { ...answer, id: "narration", turnTerminal: false };
    const notice: Message = { ...step, id: "notice", tool: { name: "notice:Using a fallback" } };
    const result = consolidateTurnActivity([ask, narration, step, notice, answer, digest]);
    expect(result.messages).toEqual([ask, narration, notice, answer]);
    expect(result.byAnswerId.get("answer")).toEqual({ steps: [step], digestMessage: digest, durationMs: 639 });
  });

  it("uses transcript timing only when there is no digest", () => {
    const result = consolidateTurnActivity([ask, step, answer]);
    expect(result.byAnswerId.get("answer")?.durationMs).toBe(1_000);
    expect(result.byAnswerId.get("answer")?.steps).toEqual([step]);
  });

  it("leaves live and turnless activity on the existing path", () => {
    const legacy = { ...step, id: "legacy", turnId: undefined };
    const rows = [ask, legacy, step, { ...answer, turnTerminal: false }];
    const result = consolidateTurnActivity(rows);
    expect(result.messages).toEqual(rows);
    expect(result.byAnswerId.size).toBe(0);
  });

  it("keeps turns separate even when their steps interleave", () => {
    const otherStep = { ...step, id: "other-step", turnId: "other-turn" };
    const otherAnswer = { ...answer, id: "other-answer", turnId: "other-turn" };
    const result = consolidateTurnActivity([ask, step, otherStep, answer, otherAnswer, digest]);
    expect(result.messages).toEqual([ask, answer, otherAnswer]);
    expect(result.byAnswerId.get("answer")?.steps).toEqual([step]);
    expect(result.byAnswerId.get("other-answer")?.steps).toEqual([otherStep]);
  });
});
