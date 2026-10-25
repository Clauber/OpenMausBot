// A custom skin is a small RECIPE a person (or their bot) can name in one
// breath — dark or light, an accent, a surface tint, how the user's own
// bubble reads, how round the corners are — plus a name. Everything else a
// skin carries (the ~30 tokens every built-in block in src/styles.css
// declares) is DERIVED here, once, contrast-safe by construction: the same
// pairs scripts/check-skin-contrast.mjs measures for the built-in skins are
// satisfied by stepping lightness until they pass, rather than by hand-tuned
// constants that can drift. The user never types a token, so the renderer
// never has to trust one: every CSS value this module emits came out of a
// number it computed.

export const SKIN_MODES = ["dark", "light"] as const;
export const SKIN_BUBBLES = ["match", "inverted"] as const;
export const SKIN_CORNERS = ["sharp", "soft", "round"] as const;
export type SkinMode = (typeof SKIN_MODES)[number];
export type SkinBubble = (typeof SKIN_BUBBLES)[number];
export type SkinCorners = (typeof SKIN_CORNERS)[number];

export interface SkinRecipe {
  mode: SkinMode;
  /** Fill colour of actions and links, `#rrggbb`. */
  accent: string;
  /** The hue cast of every surface, `#rrggbb`. A grey gives neutral surfaces. */
  tint: string;
  /** "match" tints the user's bubble one step off the card; "inverted" paints
   *  it in the opposite mode's ink, like Daylight and Meadow. */
  bubble: SkinBubble;
  corners: SkinCorners;
}

export interface CustomSkin {
  id: string;
  name: string;
  tagline: string;
  recipe: SkinRecipe;
  createdAt: number;
  updatedAt: number;
  /** Set when a bot created the skin through create_skin. */
  createdBy?: { botId: string; name: string };
}

export const SKIN_NAME_MAX = 40;
export const SKIN_TAGLINE_MAX = 120;
/** One workspace cannot hoard skins: the picker stays one screenful. */
export const MAX_CUSTOM_SKINS = 24;

// ── Validation ────────────────────────────────────────────────────────────

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

/** `#ABC` → `#aabbcc`; anything else comes back untouched. */
export function normalizeHex(value: string): string {
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value.trim());
  if (!short) return value.trim().toLowerCase();
  return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
}

export type ParsedSkinInput =
  | { ok: true; name: string; tagline: string; recipe: SkinRecipe }
  | { ok: false; error: string };

/** Narrow untrusted tool/API input into a recipe. Every rejection names the
 *  one thing to fix, so a model can correct its own call without a retry
 *  tax on the person. */
export function parseSkinInput(input: unknown): ParsedSkinInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "Give a skin as an object with name, mode and accent." };
  }
  const raw = input as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) return { ok: false, error: "name is required — what should this skin be called?" };
  if (name.length > SKIN_NAME_MAX) return { ok: false, error: `name must be at most ${SKIN_NAME_MAX} characters.` };
  const tagline = typeof raw.tagline === "string" ? raw.tagline.trim() : "";
  if (tagline.length > SKIN_TAGLINE_MAX) return { ok: false, error: `tagline must be at most ${SKIN_TAGLINE_MAX} characters.` };
  const mode = raw.mode;
  if (mode !== "dark" && mode !== "light") return { ok: false, error: 'mode must be "dark" or "light".' };
  // Three-digit hex is a human habit ("#f60"); widen it before validating.
  const accent = typeof raw.accent === "string" ? normalizeHex(raw.accent) : raw.accent;
  if (!isHexColor(accent)) return { ok: false, error: "accent must be a hex colour like #d97706." };
  const tintRaw = raw.tint === undefined || raw.tint === null || raw.tint === "" ? neutralTintFor(mode) : raw.tint;
  const tint = typeof tintRaw === "string" ? normalizeHex(tintRaw) : tintRaw;
  if (!isHexColor(tint)) return { ok: false, error: "tint must be a hex colour like #b45309, or left out for neutral surfaces." };
  const bubble = raw.bubble === undefined || raw.bubble === null || raw.bubble === "" ? "match" : raw.bubble;
  if (bubble !== "match" && bubble !== "inverted") return { ok: false, error: 'bubble must be "match" or "inverted".' };
  const corners = raw.corners === undefined || raw.corners === null || raw.corners === "" ? "soft" : raw.corners;
  if (corners !== "sharp" && corners !== "soft" && corners !== "round") {
    return { ok: false, error: 'corners must be "sharp", "soft" or "round".' };
  }
  return {
    ok: true,
    name,
    tagline,
    recipe: { mode, accent, tint, bubble, corners },
  };
}

function neutralTintFor(mode: SkinMode): string {
  return mode === "dark" ? "#1b1b1b" : "#e8e8e8";
}

// ── Colour math ───────────────────────────────────────────────────────────
// Same sRGB luminance and ratio as scripts/check-skin-contrast.mjs, so a
// generated skin measured here is measured the way `pnpm check:contrast`
// measures the built-ins.

interface Rgb { r: number; g: number; b: number }

export function hexToRgb(hex: string): Rgb {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

function rgbToHex({ r, g, b }: Rgb): string {
  const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

export interface Hsl { h: number; s: number; l: number }

export function hexToHsl(hex: string): Hsl {
  const { r, g, b } = hexToRgb(hex);
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h: h * 360, s, l };
}

export function hslToHex({ h, s, l }: Hsl): string {
  const hue = ((h % 360) + 360) % 360 / 360;
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const [s2, l2] = [clamp01(s), clamp01(l)];
  if (s2 === 0) {
    const grey = l2 * 255;
    return rgbToHex({ r: grey, g: grey, b: grey });
  }
  const q = l2 < 0.5 ? l2 * (1 + s2) : l2 + s2 - l2 * s2;
  const p = 2 * l2 - q;
  const channel = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return rgbToHex({ r: channel(hue + 1 / 3) * 255, g: channel(hue) * 255, b: channel(hue - 1 / 3) * 255 });
}

export function shade(hex: string, over: Partial<Hsl>): string {
  const base = hexToHsl(hex);
  return hslToHex({ h: over.h ?? base.h, s: over.s ?? base.s, l: over.l ?? base.l });
}

export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(fg: string, bg: string): number {
  const [hi, lo] = [relativeLuminance(fg), relativeLuminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

/** The lightness (same hue and saturation) that clears `ratio` against every
 *  background, walking from `start` in `dir`. This is how the built-in
 *  skins' comments describe their own tuning — darken until it passes —
 *  made mechanical. Returns the first lightness that passes all backgrounds;
 *  if the walk runs off the 0–1 range it returns the last step anyway, and
 *  the tests hold that line by never letting a recipe reach it. */
function passingLightness(start: number, dir: 1 | -1, h: number, s: number, bgs: readonly string[], ratio: number): number {
  let l = start;
  for (let step = 0; step < 110; step++) {
    const candidate = hslToHex({ h, s, l });
    if (bgs.every((bg) => contrastRatio(candidate, bg) >= ratio)) return l;
    l += dir * 0.01;
    if (l < 0 || l > 1) break;
  }
  return Math.max(0, Math.min(1, l));
}

// ── The token set ─────────────────────────────────────────────────────────

/** Every custom property a generated block declares — the same set a
 *  built-in skin declares, so a custom subtree styles exactly like a
 *  built-in one. */
export type SkinTokenMap = Record<string, string>;

const INTER_STACK =
  '"Inter", -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif';

const RADII: Record<SkinCorners, { lg: string; xl: string }> = {
  sharp: { lg: "4px", xl: "8px" },   // sheet metal (Foundry)
  soft: { lg: "6px", xl: "10px" },   // paper (Graphite, Atelier)
  round: { lg: "8px", xl: "14px" },  // glazed ceramic (Lagoon, Daylight)
};

/** Status hues, held near the built-ins': green, red, amber. */
const STATUS_HUES = { success: 152, danger: 356, warning: 36 } as const;

/** How far surfaces may lean into the tint before a skin stops reading as a
 *  workspace and starts reading as a wall. The built-ins' tints stay under
 *  ~30% saturation at the ground level. */
const MAX_SURFACE_SATURATION = 0.3;
const MAX_INK_SATURATION = 0.22;

// The surface ladders, one per mode. Lightness stops follow the neutral
// built-ins (Graphite for dark, Linen for light) so a custom skin lands in
// the family's register before the tint moves it anywhere.
const DARK_LADDER = { app: 0.05, panel: 0.09, card: 0.135, raised: 0.17, raisedHover: 0.225, inset: 0.025, hairline: 0.28 };
const LIGHT_LADDER = { app: 0.945, panel: 0.97, card: 1, raised: 1, raisedHover: 0.89, inset: 0.91, hairline: 0.78 };

function surfacesFor(mode: SkinMode, tint: string): Record<"app" | "panel" | "card" | "raised" | "raisedHover" | "inset" | "hairline" | "control" | "composer" | "menu", string> {
  const { h } = hexToHsl(tint);
  const rawS = hexToHsl(tint).s;
  const s = Math.min(rawS, MAX_SURFACE_SATURATION) * (mode === "dark" ? 0.85 : 1);
  const ladder = mode === "dark" ? DARK_LADDER : LIGHT_LADDER;
  const at = (stop: number, sat = s) => hslToHex({ h, s: sat, l: stop });
  const surfaces = {
    app: at(ladder.app),
    panel: at(ladder.panel),
    card: at(ladder.card),
    raised: at(ladder.raised),
    raisedHover: at(ladder.raisedHover),
    inset: at(ladder.inset),
    hairline: at(ladder.hairline),
    control: at(ladder.raised),
    composer: at(ladder.raised),
    menu: at(ladder.card),
  };
  // Hairline and control are measured, not assumed: hairline clears 1.5:1 on
  // the ground with a hair of headroom for hex rounding (as check-skin-contrast
  // asks), and control stays a visible step on every surface it can land on
  // (≥1.07 on card and panel, ≥1.05 on the rest) the way Atelier's comment
  // describes tuning its own.
  surfaces.hairline = mode === "dark"
    ? shade(surfaces.hairline, { l: passingLightness(ladder.hairline, 1, h, s, [surfaces.app, surfaces.panel], 1.55) })
    : shade(surfaces.hairline, { l: passingLightness(ladder.hairline, -1, h, s, [surfaces.app, surfaces.panel], 1.55) });
  const controlTargets = [surfaces.card, surfaces.panel, surfaces.app, surfaces.inset, surfaces.raisedHover];
  const controlRatio = 1.07;
  // For dark skins control starts at `raised` (0.17) and must stay a step
  // ABOVE its surroundings → walk up; light skins walk down toward darker.
  surfaces.control = mode === "dark"
    ? shade(surfaces.control, { l: passingLightness(ladder.raised, 1, h, s, controlTargets, controlRatio) })
    : shade(surfaces.control, { l: passingLightness(ladder.raised, -1, h, s, controlTargets, controlRatio) });
  return surfaces;
}

function inksFor(mode: SkinMode, tint: string, surfaces: ReturnType<typeof surfacesFor>): { ink: string; secondary: string; tertiary: string } {
  const { h, s: rawS } = hexToHsl(tint);
  const s = Math.min(rawS, MAX_INK_SATURATION);
  const everySurface = [surfaces.app, surfaces.panel, surfaces.raised, surfaces.raisedHover, surfaces.card, surfaces.inset, surfaces.composer, surfaces.menu];
  // The quietest ink that still clears 4.5:1 everywhere — exactly the brief
  // styles.css gives --color-ink-tertiary. The secondary walks from a plausibly
  // quiet tone toward its ground until every surface passes; the tertiary
  // starts a hair closer to the ground and walks back just far enough to
  // pass, so it lands at or below the secondary. The primary ink is a
  // near-maximum-contrast step beyond the secondary, not a hand-picked
  // near-white/near-black, so it stays tinted with the skin's hue.
  if (mode === "dark") {
    const secondaryL = passingLightness(0.68, 1, h, s, everySurface, 4.75);
    const tertiaryL = passingLightness(secondaryL - 0.035, 1, h, s, everySurface, 4.6);
    const inkL = Math.min(0.97, passingLightness(secondaryL + 0.08, 1, h, s, everySurface, 10));
    return {
      ink: hslToHex({ h, s, l: inkL }),
      secondary: hslToHex({ h, s, l: secondaryL }),
      tertiary: hslToHex({ h, s, l: tertiaryL }),
    };
  }
  const secondaryL = passingLightness(0.62, -1, h, s, everySurface, 4.75);
  const tertiaryL = passingLightness(secondaryL + 0.035, -1, h, s, everySurface, 4.6);
  const inkL = Math.max(0.05, passingLightness(Math.max(0.03, secondaryL - 0.08), -1, h, s, everySurface, 10));
  return {
    ink: hslToHex({ h, s, l: inkL }),
    secondary: hslToHex({ h, s, l: secondaryL }),
    tertiary: hslToHex({ h, s, l: tertiaryL }),
  };
}

export interface AccentSet {
  /** The fill (--color-accent). */
  accent: string;
  accentBorder: string;
  accentText: string;
  focus: string;
  accentInk: string;
}

/** The accent, in either of the two shapes the built-ins use: a DEEP fill
 *  carrying white lettering (Graphite, Atelier, Linen, Meadow, Daylight) or
 *  a BRIGHT fill carrying near-black lettering — Foundry's brass inversion,
 *  the brightest thing on screen. The recipe's lightness is honoured by
 *  picking whichever valid fill sits closest to it, so "a soft sky blue"
 *  does not come back as navy. Validity is the checker's own bar: the fill
 *  clears 3:1 against the ground, and its ink clears 4.5:1 on the fill. */
export function accentSetFor(accent: string, mode: SkinMode, surfaces: ReturnType<typeof surfacesFor>): AccentSet {
  const { h, s: rawS, l: wantedL } = hexToHsl(accent);
  const s = Math.min(rawS, 0.92);
  const darkInk = hslToHex({ h, s: Math.min(s, MAX_INK_SATURATION), l: mode === "dark" ? 0.1 : 0.14 });
  const fillWorks = (fill: string): string | null => {
    if (contrastRatio(fill, surfaces.app) < 3) return null;
    if (contrastRatio("#ffffff", fill) >= 4.5) return "#ffffff";
    if (contrastRatio(darkInk, fill) >= 4.5) return darkInk;
    return null;
  };
  let best: { fill: string; ink: string; distance: number } | null = null;
  for (let step = 0; step <= 100; step++) {
    const l = step / 100;
    const fill = hslToHex({ h, s, l });
    const ink = fillWorks(fill);
    if (ink === null) continue;
    const distance = Math.abs(l - wantedL);
    if (!best || distance < best.distance) best = { fill, ink, distance };
    if (best.distance === 0) break;
  }
  if (!best) {
    // Unreachable for any in-gamut hue at s ≤ 0.92 (mid lightness always
    // carries one of the two inks), but the fallback keeps a bad input
    // rendering as a skin instead of throwing.
    const l = mode === "dark" ? 0.55 : 0.4;
    best = { fill: hslToHex({ h, s, l }), ink: "#ffffff", distance: 1 };
  }
  const fillL = hexToHsl(best.fill).l;
  // Links and the focus ring land on every surface, and HSL lightness is not
  // luminance across hues — a tinted inset can out-luminance a lighter-looking
  // app tone. Walk against the whole ladder so no surface slips under.
  const linkGrounds = [surfaces.app, surfaces.panel, surfaces.raised, surfaces.raisedHover, surfaces.card, surfaces.inset, surfaces.composer, surfaces.menu];
  const textL = mode === "dark"
    ? passingLightness(fillL, 1, h, s, linkGrounds, 4.5)
    : passingLightness(fillL, -1, h, s, linkGrounds, 4.5);
  const accentText = hslToHex({ h, s, l: textL });
  return {
    accent: best.fill,
    // One step brighter than the fill, the way every built-in pairs them.
    accentBorder: hslToHex({ h, s, l: Math.min(1, fillL + (mode === "dark" ? 0.09 : 0.06)) }),
    accentText,
    // The ring rides the accent, not Grok blue — focus is link-strength.
    focus: accentText,
    accentInk: best.ink,
  };
}

/** Status colours: readable as text on a card AND as a fill carrying their
 *  own ink token, both at 4.5:1. */
function statusSetFor(hue: number, mode: SkinMode, surfaces: ReturnType<typeof surfacesFor>): { color: string; ink: string } {
  const s = 0.55;
  const darkInk = hslToHex({ h: hue, s: 0.5, l: mode === "dark" ? 0.1 : 0.14 });
  let l = mode === "dark" ? 0.62 : 0.42;
  const dir: 1 | -1 = mode === "dark" ? 1 : -1;
  for (let step = 0; step < 60; step++) {
    const color = hslToHex({ h: hue, s, l });
    if (contrastRatio(color, surfaces.card) >= 4.5) {
      const ink = contrastRatio("#ffffff", color) >= 4.5 ? "#ffffff" : darkInk;
      if (contrastRatio(ink, color) >= 4.5) return { color, ink };
    }
    l += dir * 0.02;
    if (l < 0 || l > 1) break;
  }
  // Fallback: the far end of the walk.
  const color = hslToHex({ h: hue, s, l: mode === "dark" ? 0.85 : 0.2 });
  return { color, ink: contrastRatio("#ffffff", color) >= 4.5 ? "#ffffff" : darkInk };
}

/** The user's own bubble. "match" keeps it in this skin's register, one step
 *  off the card (Foundry's #2a2318). "inverted" paints it in the opposite
 *  mode's ink — Daylight's near-black on near-white. */
function bubbleFor(recipe: SkinRecipe, surfaces: ReturnType<typeof surfacesFor>, inks: { ink: string; secondary: string; tertiary: string }): { user: string; userInk: string } {
  const { h, s: rawS } = hexToHsl(recipe.tint);
  const s = Math.min(rawS, MAX_SURFACE_SATURATION);
  if (recipe.bubble === "match") {
    const user = recipe.mode === "dark"
      ? hslToHex({ h, s: Math.min(1, s * 1.25), l: 0.19 })
      : surfaces.raisedHover;
    return { user, userInk: inks.ink };
  }
  if (recipe.mode === "dark") {
    // A light bubble on a dark page.
    const user = hslToHex({ h, s: s * 0.6, l: 0.95 });
    const ink = passingLightness(0.22, -1, h, Math.min(rawS, MAX_INK_SATURATION), [user], 4.5);
    return { user, userInk: hslToHex({ h, s: Math.min(rawS, MAX_INK_SATURATION), l: Math.max(0.04, ink - 0.02) }) };
  }
  // A dark bubble on a light page.
  const user = hslToHex({ h, s: s * 0.8, l: 0.06 });
  const ink = passingLightness(0.75, 1, h, Math.min(rawS, MAX_INK_SATURATION), [user], 4.5);
  return { user, userInk: hslToHex({ h, s: Math.min(rawS, MAX_INK_SATURATION), l: Math.min(0.97, ink + 0.03) }) };
}

/** The inverted bubble is a surface of the opposite mode sitting inside this
 *  skin, and everything drawn on it — the editor, quotes, attachment chips —
 *  reads that opposite context's tokens. This is the same job the `@scope`
 *  blocks do for Daylight and Meadow in styles.css: re-declare a small
 *  palette scoped to `.bg-bubble-user`. Derived from the flipped ladder so a
 *  custom skin's bubble context is as coherent as theirs. */
export function scopeTokensFor(recipe: SkinRecipe): SkinTokenMap {
  const flipped: SkinRecipe = { ...recipe, mode: recipe.mode === "dark" ? "light" : "dark" };
  const surfaces = surfacesFor(flipped.mode, recipe.tint);
  const inks = inksFor(flipped.mode, recipe.tint, surfaces);
  // Inside the bubble the accent is seen against the flipped ground, and it
  // carries its own ink for the fills drawn there.
  const accent = accentSetFor(recipe.accent, flipped.mode, surfaces);
  const danger = statusSetFor(STATUS_HUES.danger, flipped.mode, surfaces);
  const success = statusSetFor(STATUS_HUES.success, flipped.mode, surfaces);
  return {
    "--color-ink": inks.ink,
    "--color-ink-secondary": inks.secondary,
    "--color-ink-tertiary": inks.tertiary,
    "--color-panel": surfaces.panel,
    "--color-inset": surfaces.inset,
    "--color-raised": surfaces.raised,
    "--color-raised-hover": surfaces.raisedHover,
    "--color-control": surfaces.control,
    "--color-hairline": surfaces.hairline,
    "--color-accent": accent.accentText,
    "--color-accent-text": accent.accentText,
    // The fill inside the bubble is the link-strength tone, so its ink is
    // whichever of the two carries 4.5:1 on THAT tone (Daylight's scope
    // pairs #7fc0ff with near-black the same way).
    "--color-accent-ink": contrastRatio("#ffffff", accent.accentText) >= 4.5
      ? "#ffffff"
      : darkInkFor(flipped.mode, recipe.tint),
    "--color-focus": accent.accentText,
    "--color-danger": danger.color,
    "--color-danger-ink": danger.ink,
    "--color-success": success.color,
    "--color-success-ink": success.ink,
  };
}

function darkInkFor(mode: SkinMode, tint: string): string {
  const { h, s } = hexToHsl(tint);
  return hslToHex({ h, s: Math.min(s, MAX_INK_SATURATION), l: mode === "dark" ? 0.1 : 0.14 });
}

/** The full token block a custom skin runs on: every property a built-in
 *  `[data-skin]` block declares, with the same names, safe to drop into any
 *  `[data-skin="custom:<id>"]` subtree. */
export function deriveSkinTokens(recipe: SkinRecipe): SkinTokenMap {
  const surfaces = surfacesFor(recipe.mode, recipe.tint);
  const inks = inksFor(recipe.mode, recipe.tint, surfaces);
  const accent = accentSetFor(recipe.accent, recipe.mode, surfaces);
  const danger = statusSetFor(STATUS_HUES.danger, recipe.mode, surfaces);
  const success = statusSetFor(STATUS_HUES.success, recipe.mode, surfaces);
  const warning = statusSetFor(STATUS_HUES.warning, recipe.mode, surfaces);
  const bubble = bubbleFor(recipe, surfaces, inks);
  const radii = RADII[recipe.corners];
  const tokens: SkinTokenMap = {
    "--code-color-scheme": recipe.mode === "dark" ? "dark" : "light",
    "--color-app": surfaces.app,
    "--color-panel": surfaces.panel,
    "--color-raised": surfaces.raised,
    "--color-raised-hover": surfaces.raisedHover,
    "--color-composer": surfaces.composer,
    "--color-composer-ring": "transparent",
    "--color-card": surfaces.card,
    "--color-menu": surfaces.menu,
    "--color-inset": surfaces.inset,
    "--color-control": surfaces.control,
    "--color-hairline": surfaces.hairline,
    "--color-ink": inks.ink,
    "--color-ink-secondary": inks.secondary,
    "--color-ink-tertiary": inks.tertiary,
    "--color-accent": accent.accent,
    "--color-accent-border": accent.accentBorder,
    "--color-accent-text": accent.accentText,
    "--color-focus": accent.focus,
    "--color-accent-ink": accent.accentInk,
    "--color-bubble-user": bubble.user,
    "--color-bubble-user-ink": bubble.userInk,
    "--color-success": success.color,
    "--color-success-ink": success.ink,
    "--color-danger": danger.color,
    "--color-danger-ink": danger.ink,
    "--color-warning": warning.color,
    "--color-scrollbar": surfaces.hairline,
    "--color-maus-line": inks.secondary,
    "--font-sans": INTER_STACK,
    "--radius-lg": radii.lg,
    "--radius-xl": radii.xl,
  };
  return tokens;
}

/** The data-skin value a custom skin id renders under. The prefix is what
 *  keeps the localStorage choice (`omb-skin`) distinguishable from the
 *  built-in ids without widening the built-in union. */
export const CUSTOM_SKIN_PREFIX = "custom:";

export function customSkinAttr(id: string): string {
  return `${CUSTOM_SKIN_PREFIX}${id}`;
}

export function isCustomSkinAttr(value: string | undefined | null): value is string {
  return typeof value === "string" && value.startsWith(CUSTOM_SKIN_PREFIX);
}

export function customSkinIdFromAttr(value: string | undefined | null): string | null {
  if (!isCustomSkinAttr(value)) return null;
  const id = value.slice(CUSTOM_SKIN_PREFIX.length);
  return /^cs-[0-9a-f]{8}$/.test(id) ? id : null;
}

/** The one CSS value a caller may pass through verbatim: the ground colour
 *  the desktop window paints behind the page while it loads. */
export function isWindowColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}
