import { describe, expect, it, vi } from "vitest";
import { bindingConflict, matchesShortcut, parseShortcutBinding } from "./keyboard-shortcuts";

describe("editable shortcuts", () => {
  const event = (key: string, modifiers = {}) => ({ key, code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, defaultPrevented: false, ...modifiers }) as KeyboardEvent;
  it("keeps the terminal on Control, including on Mac", () => {
    expect(matchesShortcut(event("`", { ctrlKey: true }), "terminal-panel", {}, true)).toBe(true);
    expect(matchesShortcut(event("`", { metaKey: true }), "terminal-panel", {}, true)).toBe(false);
  });
  it("uses overrides exclusively with exact modifiers", () => {
    const bindings = { win: { "terminal-panel": ["Ctrl", "Shift", "T"] } };
    expect(matchesShortcut(event("T", { ctrlKey: true, shiftKey: true }), "terminal-panel", bindings, false)).toBe(true);
    expect(matchesShortcut(event("`", { ctrlKey: true }), "terminal-panel", bindings, false)).toBe(false);
    expect(matchesShortcut(event("T", { ctrlKey: true, shiftKey: true, altKey: true }), "terminal-panel", bindings, false)).toBe(false);
  });
  it("handles shifted bracket keys and numeric families", () => {
    expect(matchesShortcut(event("}", { ctrlKey: true, shiftKey: true, code: "BracketRight" }), "switch-bot", {}, false)).toBe(true);
    expect(matchesShortcut(event("3", { ctrlKey: true }), "jump-bot", {}, false)).toBe(true);
  });
  it("matches shifted digits and rejects their equivalent duplicate chords", () => {
    const bindings = { win: { "jump-bot": ["Ctrl", "Shift", "1–9"] } };
    expect(matchesShortcut(event("!", { ctrlKey: true, shiftKey: true, code: "Digit1" }), "jump-bot", bindings, false)).toBe(true);
    expect(bindingConflict("terminal-panel", ["Ctrl", "Shift", "!"], bindings, false)?.id).toBe("jump-bot");
  });
  it("rejects malformed bindings and detects overlapping fixed/family bindings", () => {
    expect(parseShortcutBinding("Ctrl+Shift+T", "terminal-panel", false)).toEqual(["Ctrl", "Shift", "T"]);
    expect(parseShortcutBinding("T", "terminal-panel", false)).toBeNull();
    expect(parseShortcutBinding("Ctrl+1", "jump-bot", false)).toBeNull();
    expect(bindingConflict("terminal-panel", ["Ctrl", "K"], {}, false)?.id).toBe("command-palette");
    expect(bindingConflict("terminal-panel", ["Ctrl", "3"], {}, false)?.id).toBe("jump-bot");
    expect(bindingConflict("terminal-panel", ["Ctrl", "Shift", "M"], {}, false)?.id).toBe("live-call-mute");
    expect(bindingConflict("terminal-panel", ["Ctrl", "Shift", "T"], {}, false)).toBeUndefined();
  });
});


it("persists separate platform choices through a fresh module load", async () => {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) });
  try {
    vi.resetModules();
    const first = await import("./keyboard-shortcuts");
    first.setShortcutBinding("terminal-panel", ["Ctrl", "Shift", "T"], false);
    first.setShortcutBinding("terminal-panel", ["⌃", "⇧", "Y"], true);
    vi.resetModules();
    const fresh = await import("./keyboard-shortcuts");
    expect(fresh.readShortcutBindings()).toEqual({ win: { "terminal-panel": ["Ctrl", "Shift", "T"] }, mac: { "terminal-panel": ["⌃", "⇧", "Y"] } });
  } finally { vi.unstubAllGlobals(); vi.resetModules(); }
});
