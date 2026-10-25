import { describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import { archiveThreadDestination, archiveThreads, isThreadRunning } from "./archive-threads";

const bot = (over: Partial<Bot> = {}): Bot => ({
  id: "bot", threadId: "a", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [], modelSelection: { instanceId: "test", model: "m" },
  tasks: [
    { threadId: "a", title: "A", createdAt: 1, updatedAt: 40, activity: "idle" },
    { threadId: "b", title: "B", createdAt: 1, updatedAt: 30, activity: "idle" },
    { threadId: "c", title: "C running", createdAt: 1, updatedAt: 20, busy: true, activity: "working" },
    { threadId: "d", title: "D waiting", createdAt: 1, updatedAt: 15, busy: true, activity: "waiting-on-you" },
    { threadId: "e", title: "E archived", createdAt: 1, updatedAt: 10, archivedAt: 5, activity: "idle" },
    { threadId: "f", title: "F", createdAt: 1, updatedAt: 5, activity: "idle" },
  ],
  ...over,
});

describe("the shared archive path", () => {
  it("applies the sidebar menu's rule: working and waiting threads are running, idle ones are not", () => {
    expect(isThreadRunning(bot(), "a")).toBe(false);
    expect(isThreadRunning(bot(), "c")).toBe(true);
    expect(isThreadRunning(bot(), "d")).toBe(true);
  });

  it("archives with the same updateTask patch the sidebar menu sends, once per thread", () => {
    const dispatch = vi.fn();
    expect(archiveThreads(dispatch, bot(), ["b", "f"], 99)).toEqual(["b", "f"]);
    expect(dispatch.mock.calls).toEqual([
      [{ type: "updateTask", botId: "bot", threadId: "b", patch: { archivedAt: 99 } }],
      [{ type: "updateTask", botId: "bot", threadId: "f", patch: { archivedAt: 99 } }],
    ]);
  });

  it("skips running and already archived threads, and says which it archived", () => {
    const dispatch = vi.fn();
    expect(archiveThreads(dispatch, bot(), ["b", "c", "d", "e", "missing"], 7)).toEqual(["b"]);
    expect(dispatch.mock.calls.map(([action]) => action.threadId)).toEqual(["b"]);
  });

  it("does nothing when nothing in the request can be archived", () => {
    const dispatch = vi.fn();
    expect(archiveThreads(dispatch, bot(), ["c", "e"], 7)).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("moves off the open thread when it is archived, to the newest thread that stays", () => {
    const dispatch = vi.fn();
    archiveThreads(dispatch, bot(), ["a", "b"], 7);
    expect(dispatch.mock.calls.at(-1)![0]).toEqual({ type: "switchTask", botId: "bot", threadId: "c" });
    expect(archiveThreadDestination(bot(), new Set(["a", "b", "c", "d"]))).toBe("f");
  });

  it("starts a new thread when every thread is gone, and leaves the open thread alone otherwise", () => {
    const only = bot({ tasks: [{ threadId: "a", title: "A", createdAt: 1 }] });
    const dispatch = vi.fn();
    archiveThreads(dispatch, only, ["a"], 7);
    expect(dispatch.mock.calls.at(-1)![0]).toEqual({ type: "newTask", botId: "bot" });
    const other = vi.fn();
    archiveThreads(other, bot(), ["b"], 7);
    expect(other.mock.calls.map(([action]) => action.type)).toEqual(["updateTask"]);
  });

  it("archives the implicit single thread of a bot without a task list", () => {
    const dispatch = vi.fn();
    expect(archiveThreads(dispatch, bot({ tasks: undefined }), ["a"], 7)).toEqual(["a"]);
    expect(dispatch.mock.calls.map(([action]) => action.type)).toEqual(["updateTask", "newTask"]);
  });
});
