// Skins are pure CSS. Every built-in one is a block of custom properties in
// styles.css, selected by a `data-skin` attribute; this module only decides
// which one is active and remembers the choice. Nothing here knows a colour —
// that keeps the two halves from drifting apart, and it means adding a skin is
// one CSS block plus one line in SKINS. User-made skins live in
// src/lib/custom-skins.ts and share this attribute and this storage key.

import { customSkinWindowColor } from "./custom-skins";

export const SKIN_IDS = [
  "midnight",
  "atelier",
  "foundry",
  "lagoon",
  "graphite",
  "linen",
  "dusk",
  "daylight",
  "meadow",
] as const;
export type SkinId = (typeof SKIN_IDS)[number];

export type Skin = {
  id: SkinId;
  name: string;
  /** One line, shown under the name in the picker. */
  tagline: string;
};

export const SKINS: readonly Skin[] = [
  { id: "midnight", name: "Midnight", tagline: "The original. Cool and dark." },
  { id: "atelier", name: "Atelier", tagline: "Daylight on paper, warm and quiet." },
  { id: "foundry", name: "Foundry", tagline: "Night shift. Dark, warm, lit in brass." },
  { id: "lagoon", name: "Lagoon", tagline: "Cool daylight. Porcelain and deep teal." },
  { id: "graphite", name: "Graphite", tagline: "Quiet charcoal and softened steel blue." },
  { id: "linen", name: "Linen", tagline: "Clean daylight with a restrained navy accent." },
  { id: "dusk", name: "Dusk", tagline: "Muted plum after dark, calm and low-key." },
  { id: "daylight", name: "Daylight", tagline: "Midnight in reverse. Near-white, ink-black bubbles." },
  { id: "meadow", name: "Meadow", tagline: "Fresh white with a calm green. The MausBot look." },
];

export const DEFAULT_SKIN: SkinId = "midnight";

// A custom skin rides the same stored choice: `omb-skin` holds either a
// built-in id or `custom:cs-xxxxxxxx`. The custom half of the value is
// validated by src/lib/custom-skins.ts (which also owns the collection
// cache), so this module only needs to know the value is not one of ours.
export function isCustomSkinValue(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("custom:cs-");
}

const KEY = "omb-skin";

// The input is whatever localStorage handed back — a string this app wrote
// on an earlier run, a value edited by hand, or a leftover from a renamed
// skin. The list is the schema.
function isSkinId(value: unknown): value is SkinId {
  // SAFETY: the assertion only satisfies includes()' parameter type; the
  // check itself is what decides, and a non-member returns false.
  return SKIN_IDS.includes(value as SkinId);
}

// Reaching for localStorage is itself a failure point: on an origin with
// storage blocked the getter throws, and `typeof` alone doesn't shield it.
function getStore(): Storage | undefined {
  try {
    // A bare feature test, not a narrowing of parsed input: in a renderer
    // without storage the identifier is simply not defined.
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** The stored choice: a built-in id, a custom reference, or the default. */
export function readSkin(): string {
  try {
    const stored = getStore()?.getItem(KEY);
    return isSkinId(stored) || isCustomSkinValue(stored) ? stored! : DEFAULT_SKIN;
  } catch {
    return DEFAULT_SKIN;
  }
}

/**
 * Point the document at a skin and remember it. Called once before the first
 * paint (main.tsx) and again on every change from the picker — a stamped
 * attribute rather than a class so it can never collide with Tailwind.
 *
 * A custom id (`custom:cs-…`) is accepted as-is: the generated block must
 * already be in the document (main.tsx ensures it from the cache; the store
 * keeps it fresh). Its ground colour rides along to the desktop bridge so
 * the native window matches while the page loads.
 */
export function applySkin(id: string): void {
  document.documentElement.dataset.skin = id;
  try {
    getStore()?.setItem(KEY, id);
  } catch {
    /* quota / private mode — the skin still applies for this session */
  }
  // The one surface CSS cannot reach: on Windows the caption buttons sit in a
  // native overlay the main process paints. Left at the default it stays
  // Midnight-black on a light skin — the "black block in the top-right
  // corner" of issue #454. Best-effort: a browser tab or an older desktop
  // build has no bridge, and the skin still applies without it. Built-in ids
  // are resolved by the main process's own table; a custom id carries its
  // derived ground because the main process has never heard of it.
  try {
    const color = isCustomSkinValue(id)
      ? customSkinWindowColor(id.slice("custom:".length))
      : undefined;
    void window.ogb?.applySkin?.(id, color)?.catch(() => undefined);
  } catch {
    /* no bridge */
  }
}
