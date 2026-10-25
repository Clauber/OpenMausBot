// "files" is available in Simple and Advanced modes.
export type ComputerPanelView = "computer" | "android" | "browser" | "routines" | "files" | "data" | "audit";

type PanelTabsContext = { advanced: boolean; androidConnected: boolean };

export function computerPanelTabs({ advanced, androidConnected }: PanelTabsContext): ComputerPanelView[] {
  return advanced
    ? ["computer", "routines", ...(androidConnected ? (["android"] as const) : []), "browser", "data", "files", "audit"]
    : ["computer", "browser", "data", "files", "audit"];
}

export function resolveComputerPanelView(view: ComputerPanelView, context: PanelTabsContext): ComputerPanelView {
  return computerPanelTabs(context).includes(view) ? view : "computer";
}

const STORAGE_PREFIX = "omb-computer-panel-view";

function storageKey(botId: string): string {
  return `${STORAGE_PREFIX}:${botId}`;
}

export function readComputerPanelView(
  botId: string,
  storage: Pick<Storage, "getItem"> = localStorage,
): ComputerPanelView {
  try {
    const value = storage.getItem(storageKey(botId));
    if (value === "android" || value === "browser" || value === "routines" || value === "files" || value === "data" || value === "audit") return value;
  } catch {
    // Storage can be unavailable in hardened or private renderer sessions.
  }
  return "computer";
}

export function writeComputerPanelView(
  botId: string,
  view: ComputerPanelView,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  try {
    storage.setItem(storageKey(botId), view);
  } catch {
    // The in-memory React state still preserves the choice for this mount.
  }
}
