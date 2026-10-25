import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  customSkinCss,
  customSkinWindowColor,
  ensureCustomSkinStyles,
  isCustomSkinId,
  readCustomSkinsCache,
  setDraftSkinStyle,
  writeCustomSkinsCache,
} from "./custom-skins";
import type { CustomSkin } from "../../shared/skin-recipe";

const SKIN: CustomSkin = {
  id: "cs-0123abcd",
  name: "Ember",
  tagline: "Warm brass on a night floor",
  recipe: { mode: "dark", accent: "#d97706", tint: "#3b2a18", bubble: "match", corners: "sharp" },
  createdAt: 1,
  updatedAt: 1,
};

const INVERTED: CustomSkin = {
  ...SKIN,
  id: "cs-11111111",
  recipe: { ...SKIN.recipe, bubble: "inverted" },
};

let storage: Record<string, string> = {};
beforeEach(() => {
  storage = {};
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, value: string) => { storage[key] = value; },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("custom skin CSS", () => {
  it("emits one block under the prefixed attribute, tokens only", () => {
    const css = customSkinCss(SKIN);
    expect(css).toContain('[data-skin="custom:cs-0123abcd"] {');
    expect(css).toContain("--color-accent: #");
    expect(css).toContain("--code-color-scheme: dark;");
    // Names and taglines are UI text, never CSS.
    expect(css).not.toContain("Ember");
    expect(css).not.toContain("Warm brass");
  });

  it("adds the scoped bubble context only for inverted recipes", () => {
    expect(customSkinCss(SKIN)).not.toContain("@scope");
    const css = customSkinCss(INVERTED);
    expect(css).toContain('@scope ([data-skin="custom:cs-11111111"]) to ([data-skin])');
    expect(css).toContain(".bg-bubble-user");
    expect(css).toContain("--color-accent-ink:");
  });

  it("refuses to emit CSS for an id that is not a skin id", () => {
    expect(customSkinCss({ ...SKIN, id: "DROP TABLE" })).toBe("");
    expect(isCustomSkinId("cs-0123abcd")).toBe(true);
    expect(isCustomSkinId("cs-XYZ")).toBe(false);
  });
});

describe("the pre-paint cache", () => {
  it("round-trips the collection", () => {
    writeCustomSkinsCache([SKIN]);
    expect(readCustomSkinsCache()).toEqual([SKIN]);
  });

  it("answers empty for junk instead of throwing", () => {
    storage["omb-custom-skins"] = "{oops";
    expect(readCustomSkinsCache()).toEqual([]);
    storage["omb-custom-skins"] = JSON.stringify([42, { id: "nope", name: "x" }, SKIN]);
    expect(readCustomSkinsCache()).toEqual([SKIN]);
  });

  it("gives the window the skin's derived ground", () => {
    writeCustomSkinsCache([SKIN]);
    expect(customSkinWindowColor(SKIN.id)).toMatch(/^#[0-9a-f]{6}$/);
    expect(customSkinWindowColor("cs-99999999")).toBeUndefined();
  });
});

describe("style injection", () => {
  it("keeps one style element in step with the collection", () => {
    const style = { id: "", textContent: "" };
    const head: unknown[] = [];
    vi.stubGlobal("document", {
      getElementById: (id: string) => (style.id === id ? style : null),
      createElement: () => style,
      head: { appendChild: (el: unknown) => head.push(el) },
    });
    ensureCustomSkinStyles([SKIN]);
    expect(style.textContent).toContain("custom:cs-0123abcd");
    ensureCustomSkinStyles([]);
    expect(style.textContent).toBe("");
  });

  it("manages the draft element for the editor's live preview", () => {
    const created: Array<{ id: string; textContent: string }> = [];
    const byId = new Map<string, { id: string; textContent: string }>();
    vi.stubGlobal("document", {
      getElementById: (id: string) => byId.get(id) ?? null,
      createElement: () => {
        const el = { id: "", textContent: "", remove: () => byId.delete("omb-custom-skin-draft") };
        created.push(el);
        return el;
      },
      head: { appendChild: (el: { id: string; textContent: string }) => byId.set(el.id, el) },
    });
    setDraftSkinStyle("cs-00000000", SKIN.recipe);
    const draft = byId.get("omb-custom-skin-draft");
    expect(draft?.textContent).toContain('data-skin="custom:cs-00000000"');
    setDraftSkinStyle("cs-00000000", null);
    expect(byId.has("omb-custom-skin-draft")).toBe(false);
  });
});
