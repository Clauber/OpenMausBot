import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { CallReceiptCard } from "./CallReceiptCard";

const receipt: Message = {
  id: "r1", role: "bot", kind: "call_receipt", at: 1, text: "Call ended",
  callReceipt: {
    callId: "c1", botId: "b", threadId: "t", startedAt: 0, endedAt: 1, durationSec: 125, outcome: "completed",
    lines: [{ side: "you", text: "hello" }, { side: "bot", text: "hi there" }],
    compute: [{ request: "check", ok: true }],
  },
};

describe("CallReceiptCard", () => {
  it("shows the duration, the delegation count and the lines", () => {
    const html = renderToStaticMarkup(createElement(CallReceiptCard, { message: receipt }));
    expect(html).toContain("2m 05s");
    expect(html).toContain("1 delegated");
    expect(html).toContain("hello");
    expect(html).toContain("hi there");
  });

  it("says so when nothing was transcribed and flags a failed call", () => {
    const html = renderToStaticMarkup(createElement(CallReceiptCard, {
      message: { ...receipt, callReceipt: { ...receipt.callReceipt!, outcome: "failed", error: "The call connection to OpenAI dropped.", lines: [], compute: undefined } },
    }));
    expect(html).toContain("Call ended with a problem");
    expect(html).toContain("Nothing was transcribed.");
    expect(html).toContain("dropped");
  });

  it("draws nothing for a message without a receipt", () => {
    expect(renderToStaticMarkup(createElement(CallReceiptCard, { message: { ...receipt, callReceipt: undefined } }))).toBe("");
  });
});
