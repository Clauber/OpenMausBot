import type { Dispatch } from "react";
import { currentTaskBot, type Action, type Bot } from "@/state/store";
import { isArchived, isWorking, orderedThreadList } from "./SidebarThreadRow";

/** The sidebar menu's own rule for Archive: a thread that is working or
 * waiting on the person is running, and a running thread is not archived.
 * Read the way the rows read it, through the thread's own state. */
export function isThreadRunning(bot: Bot, threadId: string): boolean {
  const thread = currentTaskBot(bot, threadId);
  return isWorking({ busy: thread.busy, activity: thread.activity });
}

/** Where the person lands once `leaving` threads are put away: the most
 * recent thread that stays on the list, or null when none is left. */
export function archiveThreadDestination(bot: Bot, leaving: ReadonlySet<string> = new Set([bot.threadId])): string | null {
  const staying = (bot.tasks ?? []).filter((task) => !leaving.has(task.threadId) && !isArchived(task));
  return orderedThreadList(staying)[0]?.threadId ?? null;
}

/** The one archive flow, shared by the chat header's button and the sidebar's
 * bulk action: the sidebar menu's updateTask archivedAt patch for each thread
 * that may be archived. Running threads and ones already archived are
 * skipped. The open thread always stays on the sidebar list, so when it is
 * archived the person moves to the next thread (or a fresh one). Returns the
 * thread ids that were archived. */
export function archiveThreads(dispatch: Dispatch<Action>, bot: Bot, threadIds: readonly string[], now = Date.now()): string[] {
  const tasks = bot.tasks ?? [];
  const ids = [...new Set(threadIds)].filter((id) => {
    const task = tasks.find((candidate) => candidate.threadId === id);
    // a bot without a task list has one implicit thread: the open one
    if (!task) return tasks.length === 0 && id === bot.threadId;
    return !isArchived(task) && !isThreadRunning(bot, id);
  });
  if (!ids.length) return [];
  for (const threadId of ids) dispatch({ type: "updateTask", botId: bot.id, threadId, patch: { archivedAt: now } });
  if (ids.includes(bot.threadId)) {
    const next = archiveThreadDestination(bot, new Set(ids));
    dispatch(next ? { type: "switchTask", botId: bot.id, threadId: next } : { type: "newTask", botId: bot.id });
  }
  return ids;
}
