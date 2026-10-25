import { z } from "zod";
import { sameAudience } from "./bot-visibility.ts";
import { spacesAllowBots } from "./space-scope.ts";
import { isMasterChief, masterAssignment } from "./fleet-authority.ts";
import type { GroupRecord, Store } from "./store.ts";

export const fleetRoomGrantSchema = z.object({
  issuerBotId: z.string(), assignmentRevision: z.string().min(1), memberIds: z.array(z.string()).min(1),
});
export type FleetRoomGrant = z.infer<typeof fleetRoomGrantSchema>;

export function fleetRoomSpacesAllowed(issuerBotId: string, memberIds: readonly string[]): boolean {
  return memberIds.every(id => spacesAllowBots(issuerBotId, id) &&
    memberIds.every(targetId => spacesAllowBots(id, targetId)));
}

export function fleetRoomAuthorized(store: Pick<Store, "bot" | "groupTaskByThread">, group: GroupRecord, threadId: string): boolean {
  const parsed = fleetRoomGrantSchema.safeParse(group.fleetRoomGrants?.[threadId]);
  if (!parsed.success || !store.groupTaskByThread(group.id, threadId)) return false;
  const grant = parsed.data, assignment = masterAssignment();
  const issuer = store.bot(grant.issuerBotId);
  if (!issuer || !isMasterChief(issuer) || assignment.revision !== grant.assignmentRevision) return false;
  if (grant.memberIds.length !== group.memberIds.length || !group.memberIds.every(id => grant.memberIds.includes(id))) return false;
  if (!fleetRoomSpacesAllowed(issuer.id, group.memberIds)) return false;
  const members = group.memberIds.map(id => store.bot(id));
  return members.every(bot => bot && !bot.hidden && sameAudience(bot.visibility, issuer.visibility));
}
