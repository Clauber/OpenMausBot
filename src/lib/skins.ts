import { customSkinWindowColor } from "./custom-skins";
import { hasPriorRun } from "./prior-run";

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
  "pop",
  "halloween",
] as const;
export type SkinId = (typeof SKIN_IDS)[number];

export type Skin = {
  id: SkinId;
  name: string;
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
  { id: "meadow", name: "Meadow", tagline: "Fresh white with a calm green. The Legion look." },
  { id: "pop", name: "Pop", tagline: "Cream paper, thick ink outlines, hard shadows. Chunky and cheerful." },
  { id: "halloween", name: "Halloween", tagline: "Plum after dark, lit in pumpkin orange. Bats optional." },
];

export const DEFAULT_SKIN: SkinId = "meadow";
export const PRIOR_INSTALL_SKIN: SkinId = "midnight";

// A custom skin rides the same stored choice: `omb-skin` holds either a
// built-in id or `custom:cs-xxxxxxxx`. The custom half of the value is
// validated by src/lib/custom-skins.ts (which also owns the collection
// cache), so this module only needs to know the value is not one of ours.
export function isCustomSkinValue(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("custom:cs-");
}

const KEY = "omb-skin";

function isSkinId(value: unknown): value is SkinId {
  return SKIN_IDS.includes(value as SkinId);
}

// With storage blocked the localStorage getter itself throws, and `typeof` alone doesn't shield it.
function getStore(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** The stored choice: a built-in id, a custom reference, or the default. */
export function readSkin(): string {
  try {
    const store = getStore();
    const stored = store?.getItem(KEY);
    if (isSkinId(stored) || isCustomSkinValue(stored)) return stored!;
    return hasPriorRun(store) ? PRIOR_INSTALL_SKIN : DEFAULT_SKIN;
  } catch {
    return PRIOR_INSTALL_SKIN;
  }
}

/** A custom id (`custom:cs-…`) is accepted as-is: its generated block must already be in the document. */
export function applySkin(id: string): void {
  document.documentElement.dataset.skin = id;
  try {
    getStore()?.setItem(KEY, id);
  } catch {
  }
  // On Windows the caption buttons sit in a native overlay the main process paints, out of CSS's reach;
  // it has no table for a custom id, so that one carries its derived ground colour.
  try {
    const color = isCustomSkinValue(id)
      ? customSkinWindowColor(id.slice("custom:".length))
      : undefined;
    void window.ogb?.applySkin?.(id, color)?.catch(() => undefined);
  } catch {
  }
}
