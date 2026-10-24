import { describe, expect, it } from "vitest";
import { allocDebugPort, getOrCreatePersistentContext, isValidAgentName, persistentSessions } from "../src/browser";

describe("persistent profile CDP ports", () => {
  it("keeps one port per profile and never hands it to another", () => {
    const first = allocDebugPort("port-test-a:direct");
    const second = allocDebugPort("port-test-b:direct");
    expect(second).not.toBe(first);
    expect(allocDebugPort("port-test-a:direct")).toBe(first);
  });

  it("refuses agent names that could leave the profiles directory", () => {
    expect(isValidAgentName("bot-123_x.y")).toBe(true);
    expect(isValidAgentName("_shared-profile")).toBe(true);
    for (const bad of ["..", "a/../b", ".hidden", "a..b", "", "x".repeat(97)]) {
      expect(isValidAgentName(bad)).toBe(false);
    }
  });
});

describe("concurrent profile launch", () => {
  it("shares one Chrome between callers opening the same profile at once", async () => {
    const [a, b] = await Promise.all([
      getOrCreatePersistentContext("concurrent-launch", "direct"),
      getOrCreatePersistentContext("concurrent-launch", "direct"),
    ]);
    expect(a).toBe(b);
    await a.close();
    persistentSessions.delete("concurrent-launch:direct");
  }, 60_000);
});
