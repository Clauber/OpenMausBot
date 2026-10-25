import { describe, expect, it } from "vitest";
import { callReceiptText, formatCallDuration, RECEIPT_LINE_CHARS, RECEIPT_MAX_LINES, ReceiptTranscript } from "./call-receipt.ts";

describe("ReceiptTranscript", () => {
  it("joins fragments of one side and breaks on a side change or a pause", () => {
    const log = new ReceiptTranscript();
    log.add("you", "hel", 0, 100);
    log.add("you", "lo", 100, 200);
    log.add("bot", "Hi", 300, 400);
    log.add("bot", " again", 400, 500);
    log.add("bot", "After a pause", 3_000, 3_500);
    expect(log.snapshot()).toEqual([
      { side: "you", text: "hello" },
      { side: "bot", text: "Hi again" },
      { side: "bot", text: "After a pause" },
    ]);
  });

  it("bounds lines and their length", () => {
    const log = new ReceiptTranscript();
    log.add("you", "x".repeat(RECEIPT_LINE_CHARS * 2));
    expect(log.snapshot()[0].text.length).toBe(RECEIPT_LINE_CHARS);
    for (let n = 0; n < RECEIPT_MAX_LINES * 2; n += 1) log.add(n % 2 ? "you" : "bot", `line ${n}`);
    expect(log.lines.length).toBe(RECEIPT_MAX_LINES);
  });
});

describe("receipt text", () => {
  it("formats the duration and the compact transcript", () => {
    expect(formatCallDuration(42)).toBe("42s");
    expect(formatCallDuration(125)).toBe("2m 05s");
    const base = { callId: "c", botId: "b", threadId: "t", startedAt: 0, endedAt: 1, durationSec: 65, outcome: "completed" as const };
    expect(callReceiptText({ ...base, lines: [{ side: "you", text: "hi" }, { side: "bot", text: "hello" }] })).toBe("Call ended · 1m 05s\nYou: hi\nBot: hello");
    expect(callReceiptText({ ...base, outcome: "failed", lines: [] })).toBe("Call ended with a problem · 1m 05s");
  });
});
