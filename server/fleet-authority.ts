import { cacheUntilConfigChanges } from "./config.ts";

type ChiefIdentity = { id?: string; chiefOfStaff?: boolean; hidden?: boolean };

export const masterAssignment = cacheUntilConfigChanges(config => ({
  botId: config.masterChiefOfStaffBotId ?? null,
  revision: config.masterChiefOfStaffRevision ?? "",
}));

export function isMasterChief(bot: ChiefIdentity | null | undefined): boolean {
  return Boolean(bot?.id && bot.chiefOfStaff && !bot.hidden && masterAssignment().botId === bot.id);
}

export function protectMasterChief(bot: ChiefIdentity, patch: { chiefOfStaff?: boolean; hidden?: boolean }): void {
  if (isMasterChief(bot) && (patch.chiefOfStaff === false || patch.hidden === true)) {
    throw new Error("Transfer or revoke Master Chief of Staff authority before demoting or hiding this bot");
  }
}
