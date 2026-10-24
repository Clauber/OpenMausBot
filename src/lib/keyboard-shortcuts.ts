import { useMemo, useSyncExternalStore } from "react";

/**
 * Keyboard shortcuts catalog and platform-specific key resolution.
 * Provides structured shortcut groups for navigation, chat, and workspace management.
 */

/** Single keyboard shortcut entry with descriptions and platform-specific keys. */
export interface ShortcutItem {
  /** Stable identifier for the shortcut. */
  id: string;
  /** Human-readable explanation of what the shortcut does. */
  description: string;
  /** Whether Settings can change the real handler binding. */
  rebindable?: boolean;
  /** Keys displayed on macOS (e.g. ["⌘", "K"]). */
  macKeys: string[];
  /** Keys displayed on Windows and Linux (e.g. ["Ctrl", "K"]). */
  winKeys: string[];
}

/** Group of related shortcuts displayed under a section heading. */
export interface ShortcutGroup {
  /** Category display name (e.g. "Navigation"). */
  category: string;
  /** List of shortcuts belonging to this group. */
  items: ShortcutItem[];
}

/**
 * Complete catalog of keyboard shortcuts available in OpenMausBot,
 * organized logically into categories for quick reference.
 */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    category: "Navigation",
    items: [
      { id: "open-settings", description: "Open Settings", rebindable: true, macKeys: ["⌘", ","], winKeys: ["Ctrl", ","] },
      {
        id: "command-palette",
        rebindable: true,
        description: "Open command palette (switcher & transcript search)",
        macKeys: ["⌘", "K"],
        winKeys: ["Ctrl", "K"],
      },
      {
        id: "new-bot",
        rebindable: true,
        description: "Create a new bot",
        macKeys: ["⌘", "N"],
        winKeys: ["Ctrl", "N"],
      },
      {
        id: "jump-bot",
        rebindable: true,
        description: "Jump to bot 1–9 in the roster",
        macKeys: ["⌘", "1–9"],
        winKeys: ["Ctrl", "1–9"],
      },
      {
        id: "switch-bot",
        rebindable: true,
        description: "Switch to previous / next bot",
        macKeys: ["⌘", "⇧", "[ / ]"],
        winKeys: ["Ctrl", "Shift", "[ / ]"],
      },
      {
        id: "terminal-panel",
        rebindable: true,
        description: "Toggle the terminal panel",
        macKeys: ["⌃", "`"],
        winKeys: ["Ctrl", "`"],
      },
      {
        id: "find-conversation",
        rebindable: true,
        description: "Find in conversation",
        macKeys: ["⌘", "F"],
        winKeys: ["Ctrl", "F"],
      },
    ],
  },
  {
    category: "Chat & Composer",
    items: [
      {
        id: "send-message",
        description: "Send message",
        macKeys: ["Return"],
        winKeys: ["Enter"],
      },
      {
        id: "new-line",
        description: "Insert new line without sending",
        macKeys: ["⇧", "Return"],
        winKeys: ["Shift", "Enter"],
      },
      {
        id: "edit-last-message",
        description: "Edit last message (when composer is empty)",
        macKeys: ["↑"],
        winKeys: ["↑"],
      },
      {
        id: "close-panel",
        description: "Close active drawer, modal, or find bar",
        macKeys: ["Esc"],
        winKeys: ["Esc"],
      },
      {
        id: "shortcuts-cheat-sheet",
        description: "Show keyboard shortcuts cheat sheet",
        macKeys: ["⌘", "/"],
        winKeys: ["Ctrl", "/"],
      },
    ],
  },
  {
    category: "Calls",
    items: [
      {
        id: "live-call-mute",
        description: "Mute or unmute a Live call",
        macKeys: ["⌘", "⇧", "M"],
        winKeys: ["Ctrl", "Shift", "M"],
      },
      {
        id: "live-call-hang-up",
        description: "Hang up a Live call",
        macKeys: ["⌘", "⇧", "H"],
        winKeys: ["Ctrl", "Shift", "H"],
      },
    ],
  },
  {
    category: "Management & Groups",
    items: [
      {
        id: "save-bulletin",
        description: "Save group instruction changes",
        macKeys: ["⌘", "Return"],
        winKeys: ["Ctrl", "Enter"],
      },
      {
        id: "reorder-section",
        description: "Reorder sidebar sections (focus a section heading)",
        macKeys: ["⌥", "↑ / ↓"],
        winKeys: ["Alt", "↑ / ↓"],
      },
    ],
  },
];

/** Help chords must not interrupt editing, composition, or another dialog. */
export function shouldOpenKeyboardShortcuts(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing || event.altKey) return false;
  const helpKey = event.key === "?" && !event.metaKey && !event.ctrlKey;
  const helpChord = event.key === "/" && (event.metaKey || event.ctrlKey) && !event.shiftKey;
  if (!helpKey && !helpChord) return false;
  const target = event.target;
  return !(target instanceof HTMLElement && (
    target.isContentEditable || target.closest("input, textarea, select, dialog, [role=dialog]")
  ));
}

/**
 * Detect whether the current host platform is macOS.
 * Checks Electron's window.ogb bridge first, falling back to navigator.userAgent.
 */
export function isMacPlatform(): boolean {
  if (typeof window !== "undefined" && window.ogb?.platform) {
    return window.ogb.platform === "darwin";
  }
  if (typeof navigator !== "undefined" && navigator.userAgent) {
    return navigator.userAgent.includes("Mac");
  }
  return true;
}

/**
 * Resolve the appropriate key representation for a shortcut item based on the host OS.
 */
export function shortcutKeysForPlatform(
  item: ShortcutItem,
  isMac: boolean = isMacPlatform(),
): string[] {
  return readShortcutBindings()[isMac ? "mac" : "win"]?.[item.id] ?? (isMac ? item.macKeys : item.winKeys);
}

/**
 * Filter shortcut groups by query matching item descriptions or keys.
 */
export function filterShortcutGroups(
  groups: readonly ShortcutGroup[],
  query: string,
  isMac: boolean = isMacPlatform(),
): ShortcutGroup[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...groups];

  return groups
    .map((group) => {
      const filteredItems = group.items.filter((item) => {
        const keys = shortcutKeysForPlatform(item, isMac).join(" ").toLowerCase();
        return (
          item.description.toLowerCase().includes(normalized) ||
          group.category.toLowerCase().includes(normalized) ||
          keys.includes(normalized)
        );
      });
      return { ...group, items: filteredItems };
    })
    .filter((group) => group.items.length > 0);
}


export type ShortcutBindings = Partial<Record<"mac" | "win", Record<string, string[]>>>;
export const SHORTCUT_BINDINGS_KEY = "omb-keyboard-shortcuts";
let sessionBindings: string | undefined;
const bindingListeners = new Set<() => void>();

function bindingsSnapshot(): string {
  if (sessionBindings !== undefined) return sessionBindings;
  try { return globalThis.localStorage?.getItem(SHORTCUT_BINDINGS_KEY) ?? "{}"; }
  catch { return "{}"; }
}

export function readShortcutBindings(): ShortcutBindings {
  try {
    const parsed = JSON.parse(bindingsSnapshot()) as ShortcutBindings;
    const clean: ShortcutBindings = {};
    for (const platform of ["mac", "win"] as const) {
      for (const item of SHORTCUT_GROUPS.flatMap(group => group.items)) {
        const keys = parsed?.[platform]?.[item.id];
        if (!item.rebindable || !Array.isArray(keys) || !keys.every(key => typeof key === "string")) continue;
        const valid = parseShortcutBinding(keys.join("+"), item.id, platform === "mac");
        if (valid) (clean[platform] ??= {})[item.id] = valid;
      }
    }
    return clean;
  } catch { return {}; }
}

function bindingsChanged(event: StorageEvent) {
  if (event.key !== SHORTCUT_BINDINGS_KEY && event.key !== null) return;
  sessionBindings = undefined;
  for (const listener of bindingListeners) listener();
}

function subscribeBindings(listener: () => void) {
  bindingListeners.add(listener);
  if (bindingListeners.size === 1) window.addEventListener("storage", bindingsChanged);
  return () => {
    bindingListeners.delete(listener);
    if (!bindingListeners.size) window.removeEventListener("storage", bindingsChanged);
  };
}

export function useShortcutBindings(): ShortcutBindings {
  const snapshot = useSyncExternalStore(subscribeBindings, bindingsSnapshot, () => "{}");
  return useMemo(() => readShortcutBindings(), [snapshot]);
}

function modifier(key: string): string | undefined {
  return ({ "⌘": "meta", cmd: "meta", command: "meta", meta: "meta", "⌃": "ctrl", ctrl: "ctrl", control: "ctrl",
    "⌥": "alt", alt: "alt", option: "alt", "⇧": "shift", shift: "shift" } as Record<string, string>)[key.toLowerCase()];
}

function normalizedKey(key: string): string {
  return ({ return: "enter", esc: "escape", "↑": "arrowup", "↓": "arrowdown" } as Record<string, string>)[key.toLowerCase()] ?? key.toLowerCase();
}

function expandedKeys(keys: string[]): string[] {
  const key = keys.at(-1) ?? "";
  return key === "1–9" ? Array.from({ length: 9 }, (_, index) => String(index + 1)) : key.split(" / ").map(normalizedKey);
}

/** Numeric roster shortcuts retain their digits; paired navigation accepts two keys. */
export function parseShortcutBinding(value: string, id: string, isMac = isMacPlatform()): string[] | null {
  const tokens = value.split("+").map(token => token.trim());
  const last = tokens.pop() ?? "";
  const modifiers = tokens.map(modifier);
  if (!tokens.length || modifiers.some(key => !key) || new Set(modifiers).size !== modifiers.length || !modifiers.some(key => key !== "shift")) return null;
  const validKey = (key: string) => /^[a-z0-9`,./;[\]\\'=-]$/i.test(key) || /^(?:F(?:[1-9]|1[0-2])|Arrow(?:Up|Down|Left|Right)|Enter|Tab|Space|Home|End|PageUp|PageDown)$/i.test(key);
  if (id === "jump-bot" ? last !== "1–9" : id === "switch-bot" ? last.split(" / ").length !== 2 || !last.split(" / ").every(validKey) || new Set(last.split(" / ").map(normalizedKey)).size !== 2 : !validKey(last)) return null;
  const labels = isMac ? { meta: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" } : { meta: "Meta", ctrl: "Ctrl", alt: "Alt", shift: "Shift" };
  return [...["meta", "ctrl", "alt", "shift"].filter(key => modifiers.includes(key)).map(key => labels[key as keyof typeof labels]), last.length === 1 ? last.toUpperCase() : last];
}

const shiftedKeys: Record<string, string> = { "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0", "~": "`", "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/" };

function chordKey(key: string, shift: boolean): string {
  const normalized = normalizedKey(key);
  return shift ? shiftedKeys[normalized] ?? normalized : normalized;
}

function bindingSignatures(keys: string[]): string[] {
  const modifiers = keys.slice(0, -1).map(modifier);
  const mods = [...modifiers].sort().join("+");
  return expandedKeys(keys).map(key => `${mods}:${chordKey(key, modifiers.includes("shift"))}`);
}

export function bindingConflict(id: string, keys: string[], bindings = readShortcutBindings(), isMac = isMacPlatform()): ShortcutItem | undefined {
  const signatures = bindingSignatures(keys);
  return SHORTCUT_GROUPS.flatMap(group => group.items).find(item => item.id !== id &&
    bindingSignatures(bindings[isMac ? "mac" : "win"]?.[item.id] ?? (isMac ? item.macKeys : item.winKeys)).some(key => signatures.includes(key)));
}

/** Returns the conflicting action, leaving the saved choice intact on rejection. */
export function setShortcutBinding(id: string, keys: string[] | null, isMac = isMacPlatform()): ShortcutItem | undefined {
  const item = SHORTCUT_GROUPS.flatMap(group => group.items).find(item => item.id === id);
  if (!item?.rebindable) return undefined;
  const bindings = readShortcutBindings();
  const platform = isMac ? "mac" : "win";
  const next = keys ?? (isMac ? item.macKeys : item.winKeys);
  const conflict = bindingConflict(id, next, bindings, isMac);
  if (conflict) return conflict;
  const valid = parseShortcutBinding(next.join("+"), id, isMac);
  if (!valid) return undefined;
  if (keys) (bindings[platform] ??= {})[id] = valid;
  else delete bindings[platform]?.[id];
  sessionBindings = JSON.stringify(bindings);
  try { globalThis.localStorage?.setItem(SHORTCUT_BINDINGS_KEY, sessionBindings); }
  catch { /* The binding still applies for this session when storage is blocked. */ }
  for (const listener of bindingListeners) listener();
  return undefined;
}

/** Exact modifiers keep Control distinct from Command, including inside xterm. */
export function matchesShortcut(event: KeyboardEvent, id: string, bindings = readShortcutBindings(), isMac = isMacPlatform()): boolean {
  if (event.defaultPrevented || event.isComposing || (typeof HTMLElement !== "undefined" && event.target instanceof HTMLElement && event.target.closest("[data-shortcut-editor]"))) return false;
  const item = SHORTCUT_GROUPS.flatMap(group => group.items).find(item => item.id === id);
  if (!item) return false;
  const keys = bindings[isMac ? "mac" : "win"]?.[id] ?? (isMac ? item.macKeys : item.winKeys);
  const mods = keys.slice(0, -1).map(modifier);
  if (event.metaKey !== mods.includes("meta") || event.ctrlKey !== mods.includes("ctrl") || event.altKey !== mods.includes("alt") || event.shiftKey !== mods.includes("shift")) return false;
  const key = event.code === "BracketLeft" ? "[" : event.code === "BracketRight" ? "]" : event.code === "Backquote" ? "`" : event.key === " " ? "space" : event.key;
  return expandedKeys(keys).some(binding => chordKey(binding, event.shiftKey) === chordKey(key, event.shiftKey));
}

export function shortcutPairIndex(event: KeyboardEvent, id: string): number {
  const item = SHORTCUT_GROUPS.flatMap(group => group.items).find(item => item.id === id);
  if (!item) return -1;
  const key = event.code === "BracketLeft" ? "[" : event.code === "BracketRight" ? "]" : event.key;
  return expandedKeys(shortcutKeysForPlatform(item)).findIndex(binding => chordKey(binding, event.shiftKey) === chordKey(key, event.shiftKey));
}
