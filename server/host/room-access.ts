import type { HandoffView } from "../coordinator.ts";
import { sameAudience } from "../bot-visibility.ts";
import { fleetRoomAuthorized } from "../fleet-rooms.ts";
import { canAccessTeam, canConsultMaster, coordinatorSupervises, peerAllowed } from "../peer-roster.ts";
import type { BotRecord, GroupRecord, Store } from "../store.ts";

export interface RoomAccessDeps {
  store: Store;
  spacesAllowBots?(fromBotId: string, toBotId: string): boolean;
}

/** The one copy of "may this bot speak into this room". Every caller — the bot's post_to_room tool, a
 *  webhook's room delivery — maps these problems to its own audience's wording; none adds a rule. */
export type RoomTalksVerdict =
  | { ok: true }
  | { ok: false; problem: "dm" }
  | { ok: false; problem: "not-member" }
  | { ok: false; problem: "setup" };

export function createRoomAccess({ store, spacesAllowBots = () => true }: RoomAccessDeps) {
  function roomRootProblem(node: Pick<HandoffView, "groupId" | "threadId" | "botId">): string | undefined {
    const group = node.groupId ? store.group(node.groupId) : undefined;
    const bot = store.bot(node.botId);
    if (!bot || bot.hidden) return "The addressed agent no longer exists";
    if (!group || !(group.dm ? group.threadId === node.threadId : store.groupTaskByThread(group.id, node.threadId))) return "Destination room task no longer exists";
    if (!group.memberIds.includes(bot.id)) return "The addressed agent is no longer a member of this room";
    return undefined;
  }
  function roomHandoffProblem(node: Pick<HandoffView, "groupId" | "threadId" | "botId"> & Partial<Pick<HandoffView, "kind">>, parent?: Pick<HandoffView, "groupId" | "threadId" | "botId">): string | undefined {
    const group = node.groupId ? store.group(node.groupId) : undefined;
    const bot = store.bot(node.botId);
    if (!bot || bot.hidden) return "The addressed agent no longer exists";
    if (node.groupId && (!group || group.dm || !store.groupTaskByThread(group.id, node.threadId))) return "Destination room task no longer exists";
    if (!node.groupId && !store.taskByThread(bot.id, node.threadId)) return "Destination bot task no longer exists";
    if (group && !group.memberIds.includes(bot.id)) return "The addressed agent is no longer a member of this room";
    // A room job in a thread of its own still answers to its room: a member who left it stops.
    const laneThread = laneRoomThread(node);
    const laneRoom = laneThread ? store.groupByThread(laneThread) : undefined;
    if (laneRoom && !laneRoom.dm && !laneRoom.memberIds.includes(bot.id)) return "The addressed agent is no longer a member of this room";
    // The owner's room membership is the grant inside that room's conversation; across rooms every reader still
    // matters: the sender's grant never gives a specialist another team's transcript.
    const outsideSection = (room: GroupRecord, speaker: BotRecord, threadId: string) => !fleetRoomAuthorized(store, room, threadId) && room.memberIds.some(id => {
      const member = store.bot(id);
      return member && !canAccessTeam(speaker, member.section) && !coordinatorSupervises(member, speaker);
    });
    const sameRoom = Boolean(parent && group && parent.groupId === group.id && parent.threadId === node.threadId);
    if (parent && !sameRoom && group && outsideSection(group, bot, node.threadId)) return "Destination room includes a member outside the agent's section";
    if (group && roomSetupPending(group)) return "Destination room setup is unfinished";
    if (parent) {
      const from = store.bot(parent.botId);
      const source = parent.groupId ? store.group(parent.groupId) : undefined;
      if (!from || from.hidden || (parent.groupId ? !source || !source.memberIds.includes(from.id) || !store.groupTaskByThread(source.id, parent.threadId) : !store.taskByThread(from.id, parent.threadId))) return "Source membership or task was removed";
      const consultation = !group && canConsultMaster(from, bot);
      if (!sameRoom && ((!canAccessTeam(from, bot.section) && !consultation) || (source && outsideSection(source, from, parent.threadId)))) return "Room work cannot cross the sender's section boundary";
      if (consultation && source && source.memberIds.some(id => {
        const member = store.bot(id);
        return !member || !sameAudience(member.visibility, bot.visibility);
      })) return "The Master Chief and source room must have the same audience";
      if (source && group && source.id === group.id && parent.threadId !== node.threadId) return "Same-room work must stay in the originating conversation";
      if (!spacesAllowBots(from.id, bot.id)) return "The recipient is in a space the sender cannot reach";
      const granted = sameRoom && fleetRoomAuthorized(store, group!, node.threadId);
      if (!granted && !peerAllowed(from, bot)) return "The recipient is not an allowed peer of the sender";
    }
  }

  function laneRoomThread(n: Pick<HandoffView, "botId" | "threadId" | "groupId">): string | undefined {
    if (n.groupId) return undefined;
    const opener = store.taskByThread(n.botId, n.threadId)?.openedBy;
    return opener?.kind === "work" && opener.roomLane && opener.threadId && store.groupByThread(opener.threadId) ? opener.threadId : undefined;
  }

  function roomTalks(bot: BotRecord, group: GroupRecord): RoomTalksVerdict {
    if (group.dm) return { ok: false, problem: "dm" };
    if (!group.memberIds.includes(bot.id)) return { ok: false, problem: "not-member" };
    if (roomSetupPending(group)) return { ok: false, problem: "setup" };
    return { ok: true };
  }

  function roomSetupPending(group: GroupRecord): boolean {
    const hasMarker =
      Object.prototype.hasOwnProperty.call(group, "setupCompletedAt") ||
      Object.prototype.hasOwnProperty.call(group, "setupSkippedAt");
    return (
      !group.dm &&
      hasMarker &&
      group.setupCompletedAt == null &&
      group.setupSkippedAt == null &&
      store.messagesFor(group.threadId).length === 0
    );
  }

  return { roomRootProblem, roomHandoffProblem, roomSetupPending, roomTalks, laneRoomThread };
}
