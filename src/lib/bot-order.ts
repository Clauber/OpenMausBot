import { placeFolder } from "./folder-order";

export const BOT_DRAG_TYPE = "application/x-openmausbot-bot";
export interface BotDrag {
  botId: string;
  threadId: string;
  fromPinned: boolean;
}

export function draggedBot(raw: string, bots: readonly { id: string; tasks?: { threadId: string }[]; threadId: string }[]): BotDrag | null {
  try {
    const value = JSON.parse(raw);
    const bot = bots.find(bot => bot.id === value?.botId);
    return bot && typeof value.threadId === "string" && (bot.threadId === value.threadId || bot.tasks?.some(task => task.threadId === value.threadId)) && typeof value.fromPinned === "boolean"
      ? { botId: bot.id, threadId: value.threadId, fromPinned: value.fromPinned } : null;
  } catch { return null; }
}

/** Same before/after placement as folders; the keyed bot subtree moves as one. */
export const placeBot = placeFolder;
