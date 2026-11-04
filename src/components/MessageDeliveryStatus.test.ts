import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { MessageDeliveryStatus, messageDeliveryState } from "./MessageDeliveryStatus";

setLocale("en");

const user = (id: string, extra: { failed?: boolean; error?: string } = {}) => ({
  id,
  role: "user" as const,
  kind: "text" as const,
  text: "hello",
  at: 0,
  ...extra,
});

describe("message delivery state", () => {
  it("reads the state from the message, and only for outgoing messages", () => {
    expect(messageDeliveryState(user("optimistic-1"))).toBe("sending");
    expect(messageDeliveryState(user("m1"))).toBe("sent");
    expect(messageDeliveryState(user("m1", { failed: true }))).toBe("failed");
    expect(messageDeliveryState({ ...user("m1"), role: "bot" })).toBeNull();
  });

  it("marks an optimistic message as sending and a confirmed one as sent", () => {
    const sending = renderToStaticMarkup(createElement(MessageDeliveryStatus, { message: user("optimistic-1") as never }));
    expect(sending).toContain('data-testid="delivery-status-sending"');
    expect(sending).toContain("Sending");

    const sent = renderToStaticMarkup(createElement(MessageDeliveryStatus, { message: user("m1") as never }));
    expect(sent).toContain('data-testid="delivery-status-sent"');
  });

  it("offers a retry on a failed message, and none when the caller has no retry", () => {
    const failed = user("m1", { failed: true, error: "network down" });
    const withRetry = renderToStaticMarkup(createElement(MessageDeliveryStatus, { message: failed as never, onRetry: () => {} }));
    expect(withRetry).toContain('data-testid="delivery-status-failed"');
    expect(withRetry).toContain("Retry sending message");

    const without = renderToStaticMarkup(createElement(MessageDeliveryStatus, { message: failed as never }));
    expect(without).toContain('data-testid="delivery-status-failed"');
    expect(without).not.toContain("Retry sending message");
  });

  it("draws nothing for a bot message", () => {
    expect(renderToStaticMarkup(createElement(MessageDeliveryStatus, { message: { ...user("m1"), role: "bot" } as never }))).toBe("");
  });
});
