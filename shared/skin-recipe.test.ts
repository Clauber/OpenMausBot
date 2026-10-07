import { describe, expect, it } from "vitest";

import {
  contrastRatio,
  CUSTOM_SKIN_PREFIX,
  customSkinAttr,
  customSkinIdFromAttr,
  deriveSkinTokens,
  isHexColor,
  MAX_CUSTOM_SKINS,
  normalizeHex,
  parseSkinInput,
  scopeTokensFor,
  SKIN_NAME_MAX,
  SKIN_TAGLINE_MAX,
  type SkinRecipe,
} from "./skin-recipe.ts";

// The same pairs scripts/check-skin-contrast.mjs measures for the built-in
// skins. A generated skin is held to the identical bar here, at derivation
// time, because the checker only reads styles.css and will never see a
// runtime block.
const SURFACES = [
  "--color-app", "--color-panel", "--color-raised", "--color-raised-hover",
  "--color-card", "--color-inset", "--color-composer", "--color-menu",
] as const;

type Tokens = Record<string, string>;

function checkSkin(tokens: Tokens): string[] {
  const problems: string[] = [];
  const pairs: Array<[string, string, number]> = [
    ...SURFACES.map((s) => ["--color-ink", s, 4.5] as [string, string, number]),
    ...SURFACES.map((s) => ["--color-ink-secondary", s, 4.5] as [string, string, number]),
    ...SURFACES.map((s) => ["--color-ink-tertiary", s, 4.5] as [string, string, number]),
    ["--color-bubble-user-ink", "--color-bubble-user", 4.5],
    ["--color-accent-ink", "--color-accent", 4.5],
    ["--color-danger-ink", "--color-danger", 4.5],
    ["--color-success-ink", "--color-success", 4.5],
    ["--color-accent-text", "--color-app", 4.5],
    ["--color-accent-text", "--color-panel", 4.5],
    ["--color-accent-text", "--color-card", 4.5],
    ["--color-danger", "--color-card", 4.5],
    ["--color-success", "--color-card", 4.5],
    ["--color-warning", "--color-card", 4.5],
    ["--color-hairline", "--color-app", 1.5],
    ["--color-accent", "--color-app", 3],
    ["--color-scrollbar", "--color-app", 1.5],
    ["--color-focus", "--color-app", 3],
    ["--color-focus", "--color-panel", 3],
    ["--color-focus", "--color-card", 3],
    ["--color-focus", "--color-inset", 3],
    ["--color-focus", "--color-raised", 3],
    ["--color-focus", "--color-control", 3],
    ["--color-control", "--color-card", 1.06],
    ["--color-control", "--color-panel", 1.06],
    ["--color-control", "--color-app", 1.04],
    ["--color-control", "--color-inset", 1.04],
    ["--color-control", "--color-raised-hover", 1.04],
    ["--color-raised-hover", "--color-card", 1.04],
    ["--color-inset", "--color-card", 1.04],
    ["--color-card", "--color-app", 1.04],
    ["--color-panel", "--color-app", 1.03],
  ];
  for (const [fg, bg, min] of pairs) {
    const ratio = contrastRatio(tokens[fg], tokens[bg]);
    if (ratio < min) problems.push(`${fg} on ${bg}: ${ratio.toFixed(2)}:1 (needs ${min}:1)`);
  }
  return problems;
}

function checkScope(tokens: Tokens, scope: Tokens): string[] {
  // The checker merges the scope over the skin's tokens and measures the
  // merged context, so the scope's own raised/inset/etc. are what its inks
  // land on; only --color-bubble-user survives from the base skin.
  const merged = { ...tokens, ...scope };
  const problems: string[] = [];
  for (const [fg, bg] of [
    ["--color-ink", "--color-bubble-user"],
    ["--color-ink-secondary", "--color-bubble-user"],
    ["--color-ink", "--color-raised"],
    ["--color-ink-secondary", "--color-raised-hover"],
    ["--color-ink-secondary", "--color-inset"],
    ["--color-ink-tertiary", "--color-bubble-user"],
    ["--color-ink-tertiary", "--color-raised-hover"],
    ["--color-ink-tertiary", "--color-inset"],
    ["--color-accent", "--color-inset"],
    ["--color-accent-text", "--color-bubble-user"],
    ["--color-ink", "--color-control"],
    ["--color-accent-ink", "--color-accent"],
    ["--color-danger-ink", "--color-danger"],
    ["--color-success-ink", "--color-success"],
  ] as const) {
    const ratio = contrastRatio(merged[fg], merged[bg]);
    if (ratio < 4.5) problems.push(`scope ${fg} on ${bg}: ${ratio.toFixed(2)}:1`);
  }
  return problems;
}

const RECIPES: Array<[string, SkinRecipe]> = [
  ["neutral dark", { mode: "dark", accent: "#1084fe", tint: "#1b1b1b", bubble: "match", corners: "soft" }],
  ["warm amber dark, inverted bubble", { mode: "dark", accent: "#d97706", tint: "#3b2a18", bubble: "inverted", corners: "sharp" }],
  ["cool teal light", { mode: "light", accent: "#0f766e", tint: "#d8ecec", bubble: "match", corners: "round" }],
  ["paper light, inverted bubble", { mode: "light", accent: "#a05f25", tint: "#e9e2d4", bubble: "inverted", corners: "soft" }],
  ["saturated magenta dark", { mode: "dark", accent: "#ff00ff", tint: "#ff00ff", bubble: "match", corners: "round" }],
  ["near-black accent on dark", { mode: "dark", accent: "#12203a", tint: "#14161c", bubble: "match", corners: "sharp" }],
  ["near-white accent on light", { mode: "light", accent: "#f5f0e6", tint: "#efeee9", bubble: "match", corners: "round" }],
  ["pure grey everything", { mode: "light", accent: "#808080", tint: "#c0c0c0", bubble: "inverted", corners: "soft" }],
  ["deep green light, green tint", { mode: "light", accent: "#166534", tint: "#dcf0e2", bubble: "match", corners: "sharp" }],
  ["red accent dark, blue tint", { mode: "dark", accent: "#dc2626", tint: "#1a1c2e", bubble: "inverted", corners: "round" }],
];

describe("deriveSkinTokens", () => {
  it.each(RECIPES)("%s passes every contrast pair the built-in skins are held to", (_name, recipe) => {
    const tokens = deriveSkinTokens(recipe);
    expect(checkSkin(tokens)).toEqual([]);
    if (recipe.bubble === "inverted") {
      expect(checkScope(tokens, scopeTokensFor(recipe))).toEqual([]);
    }
  });

  it("declares the same token set a built-in block does", () => {
    const tokens = Object.keys(deriveSkinTokens(RECIPES[0][1]));
    expect(tokens).toContain("--code-color-scheme");
    for (const name of [
      "--color-app", "--color-panel", "--color-raised", "--color-raised-hover", "--color-composer",
      "--color-composer-ring", "--color-card", "--color-menu", "--color-inset", "--color-control",
      "--color-hairline", "--color-ink", "--color-ink-secondary", "--color-ink-tertiary",
      "--color-accent", "--color-accent-border", "--color-accent-text", "--color-focus",
      "--color-accent-ink", "--color-bubble-user", "--color-bubble-user-ink", "--color-success",
      "--color-success-ink", "--color-danger", "--color-danger-ink", "--color-warning",
      "--color-scrollbar", "--color-maus-line", "--font-sans", "--radius-lg", "--radius-xl",
    ]) {
      expect(tokens).toContain(name);
    }
  });

  it("is deterministic for a recipe", () => {
    expect(deriveSkinTokens(RECIPES[1][1])).toEqual(deriveSkinTokens(RECIPES[1][1]));
  });

  it("carries the mode into the code scheme and corners into the radii", () => {
    expect(deriveSkinTokens(RECIPES[0][1])["--code-color-scheme"]).toBe("dark");
    expect(deriveSkinTokens(RECIPES[2][1])["--code-color-scheme"]).toBe("light");
    expect(deriveSkinTokens({ ...RECIPES[0][1], corners: "sharp" })["--radius-xl"]).toBe("8px");
    expect(deriveSkinTokens({ ...RECIPES[0][1], corners: "round" })["--radius-xl"]).toBe("14px");
  });

  it("honours a bright accent as a bright fill on dark ground (the Foundry shape)", () => {
    const tokens = deriveSkinTokens({ mode: "dark", accent: "#d99a3e", tint: "#2a1f10", bubble: "match", corners: "sharp" });
    // The brass came through at nearly its own lightness, not darkened to navy.
    const fill = tokens["--color-accent"];
    expect(contrastRatio(fill, tokens["--color-app"])).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(tokens["--color-accent-ink"], fill)).toBeGreaterThanOrEqual(4.5);
    expect(fill.toLowerCase()).not.toBe("#d99a3e");
  });

  it("inverted bubbles paint the opposite mode's ink", () => {
    const dark = deriveSkinTokens({ mode: "dark", accent: "#1084fe", tint: "#1b1b1b", bubble: "inverted", corners: "soft" });
    const light = deriveSkinTokens({ mode: "light", accent: "#1084fe", tint: "#e8e8e8", bubble: "inverted", corners: "soft" });
    expect(parseInt(dark["--color-bubble-user"].slice(1, 3), 16)).toBeGreaterThan(200);
    expect(parseInt(dark["--color-bubble-user-ink"].slice(1, 3), 16)).toBeLessThan(80);
    expect(parseInt(light["--color-bubble-user"].slice(1, 3), 16)).toBeLessThan(80);
    expect(parseInt(light["--color-bubble-user-ink"].slice(1, 3), 16)).toBeGreaterThan(180);
  });
});

describe("parseSkinInput", () => {
  const base = { name: "Ember", mode: "dark", accent: "#d97706" };

  it("accepts a minimal recipe and fills the defaults", () => {
    const parsed = parseSkinInput(base);
    expect(parsed).toEqual({
      ok: true,
      name: "Ember",
      tagline: "",
      recipe: { mode: "dark", accent: "#d97706", tint: "#1b1b1b", bubble: "match", corners: "soft" },
    });
  });

  it("expands short hex and rejects malformed colours with a fixable error", () => {
    const parsed = parseSkinInput({ ...base, accent: "#F0A" });
    expect(parsed.ok && parsed.recipe.accent).toBe("#ff00aa");
    const bad = parseSkinInput({ ...base, accent: "orange" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/accent/);
  });

  it.each([
    ["", /name is required/],
    ["x".repeat(SKIN_NAME_MAX + 1), /at most 40/],
  ])("guards the name %s", (name, matches) => {
    const parsed = parseSkinInput({ ...base, name });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(matches as RegExp);
  });

  it("guards the tagline length and every enum", () => {
    expect(parseSkinInput({ ...base, tagline: "x".repeat(SKIN_TAGLINE_MAX + 1) }).ok).toBe(false);
    expect(parseSkinInput({ ...base, mode: "twilight" }).ok).toBe(false);
    expect(parseSkinInput({ ...base, bubble: "striped" }).ok).toBe(false);
    expect(parseSkinInput({ ...base, corners: "wavy" }).ok).toBe(false);
    expect(parseSkinInput({ ...base, tint: "#12345" }).ok).toBe(false);
    expect(parseSkinInput(null).ok).toBe(false);
    expect(parseSkinInput([base]).ok).toBe(false);
  });
});

describe("hex helpers", () => {
  it("recognizes and normalizes six-digit and short hex only", () => {
    expect(isHexColor("#aabbcc")).toBe(true);
    expect(isHexColor("#ABC")).toBe(false);
    expect(isHexColor("aabbcc")).toBe(false);
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex("#AABBCC")).toBe("#aabbcc");
  });
});

describe("custom skin attribute names", () => {
  it("round-trips an id through the prefixed attribute value", () => {
    const attr = customSkinAttr("cs-0123abcd");
    expect(attr).toBe(`${CUSTOM_SKIN_PREFIX}cs-0123abcd`);
    expect(customSkinIdFromAttr(attr)).toBe("cs-0123abcd");
    expect(customSkinIdFromAttr("midnight")).toBeNull();
    expect(customSkinIdFromAttr("custom:not-an-id")).toBeNull();
    expect(customSkinIdFromAttr(undefined)).toBeNull();
  });

  it("documents the collection cap as a positive number", () => {
    expect(MAX_CUSTOM_SKINS).toBeGreaterThanOrEqual(1);
  });
});
