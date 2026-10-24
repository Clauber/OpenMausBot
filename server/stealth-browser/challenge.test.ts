import type { Page } from "patchright";
import { describe, expect, it } from "vitest";

import { armCloudflareSolver, CHECKBOX_JITTER_X, CHECKBOX_OFFSET_X, isChallengeFrameUrl } from "./challenge.ts";

/** A page with no challenge on it that counts how often the solver looks. */
function cleanPage(): { page: Page; navigate: () => void; checks: () => number } {
  let titleReads = 0;
  const listeners: Array<(frame: unknown) => void> = [];
  const mainFrame = {};
  const page = {
    isClosed: () => false,
    title: async () => { titleReads++; return "Doug Herrell Plumbing"; },
    frames: () => [],
    locator: () => ({ first: () => ({ isVisible: async () => false }) }),
    mainFrame: () => mainFrame,
    on: (event: string, listener: (frame: unknown) => void) => { if (event === "framenavigated") listeners.push(listener); },
  } as unknown as Page;
  return { page, navigate: () => { for (const listener of listeners) listener(mainFrame); }, checks: () => titleReads };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("cloudflare challenge solver", () => {
  it("recognizes the Turnstile frame by its origin, and nothing else", () => {
    expect(isChallengeFrameUrl("https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv0/0/xyz/https://example.com")).toBe(true);
    expect(isChallengeFrameUrl("http://127.0.0.1:19650/challenges.cloudflare.com/widget")).toBe(true);
    expect(isChallengeFrameUrl("https://example.com/")).toBe(false);
    expect(isChallengeFrameUrl("about:blank")).toBe(false);
    expect(isChallengeFrameUrl("")).toBe(false);
  });

  it("watches a page once however often the runtime re-arms it", async () => {
    // The runtime re-arms every open page each time any new page attaches
    // (the solver's own shadow page included), so arming must be idempotent.
    const { page, navigate, checks } = cleanPage();
    for (let i = 0; i < 5; i++) armCloudflareSolver(page);
    await settle();
    expect(checks()).toBe(1);
    navigate();
    await settle();
    expect(checks()).toBe(2);
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
