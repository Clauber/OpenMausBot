// @vitest-environment happy-dom
// Multi-select in a bot's thread list: shift+click for a range, Cmd/Ctrl+click
// to toggle one, a bulk "Archive N threads" bar that archives through the
// same helper as the header's Archive thread button, Esc / outside click to
// clear, and plain clicks still opening threads exactly as before.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, type Bot } from "@/state/store";

const shared = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));
vi.mock("./archive-threads", async (importOriginal) => {
  const original = await importOriginal<typeof import("./archive-threads")>();
  return { ...original, archiveThreads: (...args: Parameters<typeof original.archiveThreads>) => { shared.calls.push(args); return original.archiveThreads(...args); } };
});

const { BotThreadList, botRowProps } = await import("./Sidebar");
const { t } = await import("@/lib/i18n");

const bot: Bot = {
  id: "maus", threadId: "t1", name: "Maus", title: "", description: "", notifications: true,
  color: "green", unread: false, busy: false, messages: [], modelSelection: { instanceId: "fake", model: "test" },
  tasks: [1, 2, 3, 4, 5].map((n) => ({ threadId: `t${n}`, title: `Thread ${n}`, createdAt: 1, updatedAt: 60 - n, activity: "idle" as const })),
};
const withRunning: Bot = { ...bot, tasks: bot.tasks!.map((task) => task.threadId === "t3" ? { ...task, busy: true, activity: "working" as const } : task) };

let host: HTMLDivElement;
let outside: HTMLButtonElement;
let root: Root;
const dispatch = vi.fn();
const mount = (candidate: Bot) => flushSync(() => root.render(createElement(BotThreadList, {
  ...botRowProps(initialState, dispatch, candidate, { density: "comfortable", quiet: false, query: "", onMenu: vi.fn() }),
  selected: true,
})));
const row = (id: string) => host.querySelector<HTMLElement>(`[data-sidebar-thread-row="${id}"]`)!;
const selectedIds = () => [...host.querySelectorAll<HTMLElement>("[data-sidebar-thread-row][data-selected]")].map((el) => el.dataset.sidebarThreadRow);
const click = (id: string, init: MouseEventInit = {}) => flushSync(() => { row(id).dispatchEvent(new MouseEvent("click", { bubbles: true, ...init })); });
const bar = () => host.querySelector<HTMLElement>("[data-sidebar-bulk-bar]");
const bulkButton = () => host.querySelector<HTMLButtonElement>("[data-sidebar-bulk-archive]")!;
const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
const press = (key: string) => flushSync(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key })); });

beforeEach(() => {
  dispatch.mockClear();
  shared.calls.length = 0;
  host = document.createElement("div");
  outside = document.createElement("button");
  document.body.append(host, outside);
  root = createRoot(host);
});
afterEach(() => { flushSync(() => root.unmount()); host.remove(); outside.remove(); });

describe("plain clicks", () => {
  it("still open the thread exactly as before and select nothing", () => {
    mount(bot);
    click("t4");
    expect(dispatch.mock.calls).toEqual([[{ type: "switchTask", botId: "maus", threadId: "t4" }]]);
    click("t1");
    expect(dispatch.mock.calls.at(-1)).toEqual([{ type: "select", id: "maus" }]);
    expect(selectedIds()).toEqual([]);
    expect(bar()).toBeNull();
  });

  it("drop an active selection but still open the thread", () => {
    mount(bot);
    click("t2", { ctrlKey: true });
    click("t4");
    expect(selectedIds()).toEqual([]);
    expect(dispatch.mock.calls).toEqual([[{ type: "switchTask", botId: "maus", threadId: "t4" }]]);
  });
});

describe("range and toggle selection", () => {
  it("shift+click selects the range from the open thread, in displayed order, without opening anything", () => {
    mount(bot);
    click("t4", { shiftKey: true });
    expect(selectedIds()).toEqual(["t1", "t2", "t3", "t4"]);
    click("t2", { shiftKey: true });
    expect(selectedIds()).toEqual(["t1", "t2"]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("shift+click extends from the last Cmd/Ctrl+clicked row, in either direction", () => {
    mount(bot);
    click("t4", { ctrlKey: true });
    click("t2", { shiftKey: true });
    expect(selectedIds()).toEqual(["t2", "t3", "t4"]);
  });

  it("Ctrl+click and Cmd+click toggle a single thread in and out", () => {
    mount(bot);
    click("t2", { ctrlKey: true });
    click("t4", { metaKey: true });
    expect(selectedIds()).toEqual(["t2", "t4"]);
    click("t2", { ctrlKey: true });
    expect(selectedIds()).toEqual(["t4"]);
    click("t4", { metaKey: true });
    expect(selectedIds()).toEqual([]);
    expect(bar()).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("marks selected rows with a styling hook and leaves the rest alone", () => {
    mount(bot);
    click("t2", { ctrlKey: true });
    expect(row("t2").dataset.selected).toBe("true");
    expect(row("t2").parentElement!.className).toContain("bg-accent");
    expect(row("t3").dataset.selected).toBeUndefined();
  });
});

describe("bulk archive bar", () => {
  it("shows the count and archives every selected thread through the shared helper after a confirmation", () => {
    mount(bot);
    click("t2", { ctrlKey: true });
    click("t4", { ctrlKey: true });
    expect(bar()!.textContent).toContain(t("task.bulk.selected", { count: 2 }));
    expect(bulkButton().textContent).toBe(t("task.bulk.archive", { count: 2 }));
    expect(bulkButton().textContent).toBe("Archive 2 threads");
    flushSync(() => bulkButton().click());
    expect(dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain(t("task.bulk.confirmTitle", { count: 2 }));
    expect(document.activeElement?.textContent).toBe("Cancel");
    expect(dispatch).not.toHaveBeenCalled();
    vi.spyOn(Date, "now").mockReturnValue(4321);
    flushSync(() => document.querySelector<HTMLButtonElement>('[role="alertdialog"] button:last-of-type')!.click());
    expect(shared.calls).toHaveLength(1);
    expect(shared.calls[0]![2]).toEqual(["t2", "t4"]);
    expect(dispatch.mock.calls).toEqual([
      [{ type: "updateTask", botId: "maus", threadId: "t2", patch: { archivedAt: 4321 } }],
      [{ type: "updateTask", botId: "maus", threadId: "t4", patch: { archivedAt: 4321 } }],
    ]);
    expect(selectedIds()).toEqual([]);
    expect(dialog()).toBeNull();
    vi.restoreAllMocks();
  });

  it("says Archive 1 thread for a single selection", () => {
    mount(bot);
    click("t2", { ctrlKey: true });
    expect(bulkButton().textContent).toBe(t("task.bulk.archiveOne"));
  });

  it("moves off the open thread when it is part of the selection", () => {
    mount(bot);
    click("t2", { shiftKey: true });
    flushSync(() => bulkButton().click());
    flushSync(() => document.querySelector<HTMLButtonElement>('[role="alertdialog"] button:last-of-type')!.click());
    expect(dispatch.mock.calls.map(([action]) => `${action.type}:${action.threadId}`)).toEqual(["updateTask:t1", "updateTask:t2", "switchTask:t3"]);
  });

  it("Cancel archives nothing and keeps the selection", () => {
    mount(bot);
    click("t2", { ctrlKey: true });
    flushSync(() => bulkButton().click());
    flushSync(() => [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find((b) => b.textContent === "Cancel")!.click());
    expect(dialog()).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
    expect(selectedIds()).toEqual(["t2"]);
  });

  it("blocks running threads by the sidebar menu's rule: they stay selected-looking but are not counted or archived", () => {
    mount(withRunning);
    click("t2", { ctrlKey: true });
    click("t3", { ctrlKey: true });
    click("t4", { ctrlKey: true });
    expect(bulkButton().textContent).toBe("Archive 2 threads");
    expect(bar()!.textContent).toContain(t("task.bulk.skipped", { count: 1 }));
    flushSync(() => bulkButton().click());
    flushSync(() => document.querySelector<HTMLButtonElement>('[role="alertdialog"] button:last-of-type')!.click());
    expect(dispatch.mock.calls.map(([action]) => action.threadId)).toEqual(["t2", "t4"]);
  });

  it("is inert when only running threads are selected", () => {
    mount(withRunning);
    click("t3", { ctrlKey: true });
    expect(bulkButton().getAttribute("aria-disabled")).toBe("true");
    flushSync(() => bulkButton().click());
    expect(dialog()).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("clearing the selection", () => {
  it("Escape clears it", () => {
    mount(bot);
    click("t2", { ctrlKey: true });
    press("Escape");
    expect(selectedIds()).toEqual([]);
    expect(bar()).toBeNull();
  });

  it("a click outside the list clears it, a click inside the bar does not", () => {
    mount(bot);
    click("t2", { ctrlKey: true });
    flushSync(() => { bar()!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(selectedIds()).toEqual(["t2"]);
    flushSync(() => { outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(selectedIds()).toEqual([]);
  });

  it("the Clear button clears it", () => {
    mount(bot);
    click("t2", { ctrlKey: true });
    flushSync(() => host.querySelector<HTMLButtonElement>("[data-sidebar-bulk-clear]")!.click());
    expect(selectedIds()).toEqual([]);
  });

  it("Escape closes the confirmation without also dropping the selection", () => {
    mount(bot);
    click("t2", { ctrlKey: true });
    flushSync(() => bulkButton().click());
    press("Escape");
    expect(dialog()).toBeNull();
    expect(selectedIds()).toEqual(["t2"]);
  });
});
