// The client half of custom skins: turn a stored recipe into the one CSS
// block the browser needs, keep it in the document, and cache the collection
// in localStorage so main.tsx can paint the chosen custom skin before the
// first frame — the same pre-paint contract the built-in skins have, fed by
// a write-through mirror of the server's collection instead of the source of
// truth itself.
//
// Injection safety: the only things interpolated into the CSS are the skin id
// (regex-checked before use) and the derived token values, which this module
// computes from numbers. Names and taglines are UI text, never CSS.
import {
  CUSTOM_SKIN_PREFIX,
  customSkinAttr,
  deriveSkinTokens,
  scopeTokensFor,
  type CustomSkin,
  type SkinRecipe,
} from "../../shared/skin-recipe";

const KEY = "omb-custom-skins";

function getStore(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function isCustomSkinId(value: unknown): value is string {
  return typeof value === "string" && /^cs-[0-9a-f]{8}$/.test(value);
}

/** Whatever the cache has, narrowed. A bad entry is dropped, not trusted:
 *  the cache is untrusted storage the server re-authoritates on hydration. */
export function readCustomSkinsCache(): CustomSkin[] {
  try {
    const raw = getStore()?.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is CustomSkin => {
      if (typeof entry !== "object" || entry === null) return false;
      const skin = entry as Partial<CustomSkin>;
      return isCustomSkinId(skin.id)
        && typeof skin.name === "string"
        && typeof skin.recipe === "object" && skin.recipe !== null
        && typeof skin.recipe.mode === "string";
    });
  } catch {
    return [];
  }
}

export function writeCustomSkinsCache(skins: readonly CustomSkin[]): void {
  try {
    getStore()?.setItem(KEY, JSON.stringify(skins));
  } catch {
    /* quota / private mode — the server list still arrives on hydration */
  }
}

function declarations(tokens: Record<string, string>): string {
  return Object.entries(tokens).map(([name, value]) => `  ${name}: ${value};`).join("\n");
}

/** The `[data-skin]` block for one custom skin, plus the scoped bubble
 *  context when the recipe inverts the user's bubble — the runtime twin of
 *  the daylight/meadow blocks in styles.css. */
export function customSkinCss(skin: CustomSkin): string {
  if (!isCustomSkinId(skin.id)) return "";
  const attr = customSkinAttr(skin.id);
  const block = `[data-skin="${attr}"] {\n${declarations(deriveSkinTokens(skin.recipe))}\n}`;
  if (skin.recipe.bubble !== "inverted") return block;
  const scope = declarations(scopeTokensFor(skin.recipe));
  return `${block}\n\n/* The user's own bubble is a surface of the opposite mode; everything\n   drawn on it reads these tokens, exactly like the built-in inverted skins. */\n@scope ([data-skin="${attr}"]) to ([data-skin]) {\n  .bg-bubble-user {\n${scope.split("\n").map((line) => `  ${line}`).join("\n")}\n  }\n}`;
}

/** The editor's live preview: a draft recipe under a synthetic id, in its own
 *  style element so it never mixes with the saved collection. */
export function setDraftSkinStyle(id: string, recipe: SkinRecipe | null): void {
  const DOCUMENT = typeof document === "undefined" ? undefined : document;
  const el = DOCUMENT?.getElementById("omb-custom-skin-draft");
  if (!DOCUMENT) return;
  if (recipe === null || !isCustomSkinId(id)) {
    el?.remove();
    return;
  }
  const attr = customSkinAttr(id);
  const css = `[data-skin="${attr}"] {\n${declarations(deriveSkinTokens(recipe))}\n}`;
  let style = el;
  if (!style) {
    style = DOCUMENT.createElement("style");
    style.id = "omb-custom-skin-draft";
    DOCUMENT.head.appendChild(style);
  }
  style.textContent = css;
}

const STYLE_ID = "omb-custom-skins";

/** Make the document carry a block for every saved skin (and no stale ones).
 *  Idempotent: the picker's miniatures and an applied skin both need the
 *  block, and neither knows whether a previous call already made it. */
export function ensureCustomSkinStyles(skins: readonly CustomSkin[]): void {
  const DOCUMENT = typeof document === "undefined" ? undefined : document;
  if (!DOCUMENT) return;
  const css = skins.map(customSkinCss).filter(Boolean).join("\n\n");
  let style = DOCUMENT.getElementById(STYLE_ID);
  if (!style) {
    style = DOCUMENT.createElement("style");
    style.id = STYLE_ID;
    // After the styles.css import, so equal specificity resolves by order —
    // though the [data-skin] blocks never overlap a custom id anyway.
    DOCUMENT.head.appendChild(style);
  }
  style.textContent = css;
}

/** The window-chrome colour for a custom skin: its derived ground. The
 *  desktop paints this behind the page so a cold start on a light custom
 *  skin does not flash black (issue #454's fix, extended to customs). */
export function customSkinWindowColor(id: string): string | undefined {
  const skin = readCustomSkinsCache().find((candidate) => candidate.id === id);
  if (!skin) return undefined;
  const tokens = deriveSkinTokens(skin.recipe);
  const color = tokens["--color-app"];
  return typeof color === "string" && /^#[0-9a-f]{6}$/.test(color) ? color : undefined;
}

export { CUSTOM_SKIN_PREFIX, customSkinAttr };
