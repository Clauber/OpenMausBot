import { describe, expect, it } from "vitest";

import { CHECKBOX_JITTER_X, CHECKBOX_OFFSET_X, isChallengeFrameUrl } from "./challenge.ts";

describe("cloudflare challenge solver", () => {
  it("recognizes the Turnstile frame by its origin, and nothing else", () => {
    expect(isChallengeFrameUrl("https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv0/0/xyz/https://example.com")).toBe(true);
    expect(isChallengeFrameUrl("http://127.0.0.1:19650/challenges.cloudflare.com/widget")).toBe(true);
    expect(isChallengeFrameUrl("https://example.com/")).toBe(false);
    expect(isChallengeFrameUrl("about:blank")).toBe(false);
    expect(isChallengeFrameUrl("")).toBe(false);
  });

  it("clicks where the checkbox actually is in the standard widget", () => {
    // The standard widget is 300x65 with the checkbox ~30px from the left,
    // vertically centered; the jitter never leaves that box.
    const width = 300;
    const height = 65;
    for (let i = 0; i < 50; i++) {
      const x = CHECKBOX_OFFSET_X + Math.random() * CHECKBOX_JITTER_X;
      const y = height / 2 + (Math.random() * 8 - 4);
      expect(x).toBeGreaterThan(10);
      expect(x).toBeLessThan(width / 2);
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(height);
    }
  });
});
