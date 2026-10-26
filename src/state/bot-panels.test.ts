import { afterEach, describe, expect, it, vi } from "vitest";
import { BOT_PANELS_KEY, readBotPanels, rememberBotPanels, type BotPanel } from "./bot-panels";

const panel: BotPanel = {
  settingsOpen: true, botSettingsSection: "messaging",
  botSettingsExpandAccordion: false, botSettingsSectionStored: true,
};
afterEach(() => vi.unstubAllGlobals());

describe("bot panel storage", () => {
  it("round trips each bot including closed and collapsed choices", () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    });
    const panels = { alpha: panel, beta: { ...panel, settingsOpen: false, botSettingsSection: "soul" as const } };
    rememberBotPanels(panels);
    expect(readBotPanels()).toEqual(panels);
    expect(stored.has(BOT_PANELS_KEY)).toBe(true);
  });

  it.each(["bad json", "null", "[]", '"soul"'])("ignores malformed storage %s", (stored) => {
    vi.stubGlobal("localStorage", { getItem: () => stored });
    expect(readBotPanels()).toEqual({});
  });

  it("keeps valid entries when another bot has invalid or obsolete data", () => {
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({
      alpha: panel, beta: { ...panel, botSettingsSection: "removed" },
      gamma: { ...panel, settingsOpen: "true" }, delta: null,
    }) });
    expect(readBotPanels()).toEqual({ alpha: panel });
  });

  it("tolerates inaccessible and unavailable storage", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("quota"); },
    });
    expect(readBotPanels()).toEqual({});
    expect(() => rememberBotPanels({ alpha: panel })).not.toThrow();
    vi.stubGlobal("localStorage", undefined);
    expect(readBotPanels()).toEqual({});
    expect(() => rememberBotPanels({ alpha: panel })).not.toThrow();
  });
});
