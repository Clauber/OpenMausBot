// Master Chief of Staff tools a bot calls with its turn capability. index.ts runs this inside its
// internal-capability dispatcher, after the turn token, sender and conversation checks.
import type { ServerResponse } from "node:http";
import { isAbsolute, join, relative, sep } from "node:path";
import { canReachPeer } from "../peer-roster.ts";
import { TASK_WORKSPACES_DIR, workspaceDir } from "../workspace.ts";
import { z } from "zod";
import { isMasterChief } from "../fleet-authority.ts";
import type { json, readBody } from "../harness/http.ts";
import { changeMasterPermission } from "../master-permissions.ts";
import type { BotRecord, Store } from "../store.ts";
import { PASS } from "./table.ts";

export interface FleetInternalRequest {
  method: string;
  path: string;
  res: ServerResponse;
  json: typeof json;
  /** The bot the turn capability belongs to, never a caller-supplied id. */
  sender: BotRecord;
  threadId: string;
  guestDriven: boolean;
  readBody(): ReturnType<typeof readBody>;
  requireActive(): void;
}

export function createFleetInternalRoutes(deps: {
  store: Store;
  canReadThread(threadId: string): boolean;
  fullAccess(botId: string, threadId: string): boolean;
  invokeApproval(message: Record<string, unknown>, reply: (result: unknown) => void): boolean;
}) {
  return async ({ method, path, res, json, sender, threadId, guestDriven, readBody, requireActive }: FleetInternalRequest): Promise<typeof PASS | void> => {
    if (method !== "POST") return PASS;
    if (path === "/api/internal/fleet/bot-folders") {
      const parsed = z.object({ targetBotId: z.string().min(1).max(128) }).strict().safeParse(await readBody());
      requireActive();
      const actor = deps.store.bot(sender.id);
      if (guestDriven || !deps.canReadThread(threadId) || !actor || !isMasterChief(actor)) {
        return json(res, 403, { error: "Master Chief of Staff authority in an owner conversation is required" });
      }
      if (!parsed.success) return json(res, 400, { error: "Provide only targetBotId from list_bots" });
      const target = deps.store.bot(parsed.data.targetBotId);
      if (!target || (actor.id !== target.id && !canReachPeer(actor, target))) {
        return json(res, 403, { error: "That bot is unavailable to the Master Chief" });
      }
      const tasks = deps.store.tasks(target.id);
      const privateTasks = tasks.filter(task => !deps.canReadThread(task.threadId));
      const privateFolders = privateTasks.flatMap(task => [join(TASK_WORKSPACES_DIR, target.id, task.threadId), ...(task.cwd ? [task.cwd] : [])]);
      const visibleFolder = (folder: string | null | undefined) => folder && isAbsolute(folder) && !privateFolders.some(privateFolder => {
        return [relative(folder, privateFolder), relative(privateFolder, folder)].some(part =>
          part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
      }) ? folder : undefined;
      return json(res, 200, {
        botId: target.id,
        sharedBotFolder: visibleFolder(workspaceDir(target.id)),
        otherThreadFiles: visibleFolder(join(TASK_WORKSPACES_DIR, target.id)),
        configuredProjectFolder: visibleFolder(target.cwd),
        tasks: tasks.filter(task => deps.canReadThread(task.threadId)).flatMap(task => {
          const folder = visibleFolder(task.cwd);
          return folder ? [{ threadId: task.threadId, workingFolder: folder }] : [];
        }),
        note: "These folders are authorized for the Master Chief. Native file tools still enforce this turn's permissions. Coordinate before changing another active task's files.",
      });
    }
    if (path === "/api/internal/fleet/approval") {
      const body = await readBody();
      const result = await changeMasterPermission({ store: deps.store, actorBotId: sender.id, threadId,
        requireActive, fullAccess: () => deps.fullAccess(sender.id, threadId), invoke: deps.invokeApproval }, body);
      return json(res, 200, result);
    }
    if (path === "/api/internal/fleet/room-task") {
      const body = z.object({ groupId: z.string(), title: z.string().min(1).max(80) }).strict().parse(await readBody());
      if (!isMasterChief(deps.store.bot(sender.id)) || !deps.fullAccess(sender.id, threadId)) {
        return json(res, 403, { error: "Master Chief of Staff authority and a Full Access turn are required" });
      }
      try {
        const task = deps.store.createFleetRoomTask(sender.id, body.groupId, body.title);
        return json(res, 201, { state: "applied", roomId: body.groupId, threadId: task.threadId });
      } catch (error) {
        return json(res, 403, { state: "rejected", error: error instanceof Error ? error.message : String(error) });
      }
    }
    return PASS;
  };
}
