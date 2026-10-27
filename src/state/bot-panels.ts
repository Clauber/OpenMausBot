import { z } from "zod";
import { BOT_SETTINGS_SECTION_IDS } from "@/lib/last-bot-section";
import type { Action, AppState, BotSettingsSection } from "./store";

export type BotPanel = Pick<AppState, "settingsOpen" | "botSettingsSection" |
  "botSettingsExpandAccordion" | "botSettingsSectionStored">;

export const BOT_PANELS_KEY = "openmausbot.botPanels.v1";
const panelSchema = z.object({
  settingsOpen: z.boolean(),
  botSettingsSection: z.custom<BotSettingsSection>((value) => BOT_SETTINGS_SECTION_IDS.some((id) => id === value)),
  botSettingsExpandAccordion: z.boolean(),
  botSettingsSectionStored: z.boolean(),
});
const emptyPanel: BotPanel = {
  settingsOpen: false, botSettingsSection: "overview",
  botSettingsExpandAccordion: false, botSettingsSectionStored: false,
};

export function readBotPanels(): Record<string, BotPanel> {
  try {
    const stored: unknown = JSON.parse(globalThis.localStorage?.getItem(BOT_PANELS_KEY) ?? "{}");
    const entries = z.record(z.string(), z.unknown()).safeParse(stored);
    if (!entries.success) return {};
    return Object.fromEntries(Object.entries(entries.data).flatMap(([id, value]) => {
      const panel = panelSchema.safeParse(value);
      return panel.success ? [[id, panel.data]] : [];
    }));
  } catch {
    return {};
  }
}

export function rememberBotPanels(panels: Record<string, BotPanel>): void {
  try {
    globalThis.localStorage?.setItem(BOT_PANELS_KEY, JSON.stringify(panels));
  } catch {
  }
}

function panelOwner(state: AppState): string | undefined {
  if (state.groups.some((group) => group.id === state.selectedId)) return undefined;
  return (state.bots.find((bot) => bot.id === state.selectedId) ?? state.bots[0])?.id;
}

function currentPanel(state: AppState): BotPanel {
  return {
    settingsOpen: state.settingsOpen, botSettingsSection: state.botSettingsSection,
    botSettingsExpandAccordion: state.botSettingsExpandAccordion,
    botSettingsSectionStored: state.botSettingsSectionStored,
  };
}

function storePanel(panels: Record<string, BotPanel>, id: string, panel: BotPanel): Record<string, BotPanel> {
  const old = panels[id];
  return old && old.settingsOpen === panel.settingsOpen && old.botSettingsSection === panel.botSettingsSection &&
    old.botSettingsExpandAccordion === panel.botSettingsExpandAccordion && old.botSettingsSectionStored === panel.botSettingsSectionStored
    ? panels : { ...panels, [id]: panel };
}

export function restoreBotPanel(state: AppState, botId: string | undefined): AppState {
  if (botId === panelOwner(state)) return state;
  const panel = botId ? state.botPanels[botId] ?? emptyPanel : emptyPanel;
  return { ...state, ...panel, botSettingsExpandRemembered: panel.botSettingsExpandAccordion };
}

export function reconcileBotPanels(before: AppState, next: AppState, action: Action): AppState {
  if (before === next) return next;
  const previousId = panelOwner(before);
  const nextId = panelOwner(next);
  let panels = next.botPanels;
  if (previousId) panels = storePanel(panels, previousId, currentPanel(before));
  const switching = previousId !== nextId || (action.type === "hydrate" && !before.hydrated);
  if (switching && action.type !== "toggleSettings") {
    const panel = nextId ? panels[nextId] ?? emptyPanel : emptyPanel;
    next = { ...next, ...panel, botSettingsExpandRemembered: panel.botSettingsExpandAccordion };
  }
  if (nextId) panels = storePanel(panels, nextId, currentPanel(next));
  if (action.type === "hydrate" || action.type === "deleteBot") {
    const kept = Object.entries(panels).filter(([id]) => next.bots.some((bot) => bot.id === id));
    if (kept.length !== Object.keys(panels).length) panels = Object.fromEntries(kept);
  }
  return panels === next.botPanels ? next : { ...next, botPanels: panels };
}
