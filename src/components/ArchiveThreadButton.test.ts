// @vitest-environment happy-dom
// The header's Archive thread button reuses the sidebar's archive path
// (updateTask archivedAt), behind the same ConfirmDialog pattern the bot
// archive uses, and never fires on a thread that is running.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: {}, dispatch: fixture.dispatch }),
}));

const { ArchiveThreadButton, archiveThreadDestination } = await import("./ArchiveThreadButton");
const { t } = await import("@/lib/i18n");

const bot = (over: Partial<Bot> = {}): Bot => ({
  id: "bot", threadId: "current", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [], modelSelection: { instanceId: "test", model: "m" },
  tasks: [
    { threadId: "current", title: "Quarterly report", createdAt: 1, activity: "idle" },
    { threadId: "older", title: "Older", createdAt: 0, updatedAt: 5, activity: "idle" },
    { threadId: "put-away", title: "Put away", createdAt: 0, updatedAt: 9, archivedAt: 3, activity: "idle" },
  ],
  ...over,
});

let host: HTMLDivElement;
let root: Root;
const mount = (b: Bot) => { flushSync(() => root.render(createElement(ArchiveThreadButton, { bot: b }))); };
const button = () => host.querySelector<HTMLButtonElement>("[data-archive-thread]")!;
const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
const click = (el: HTMLElement) => flushSync(() => el.click());

beforeEach(() => {
  fixture.dispatch.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { flushSync(() => root.unmount()); host.remove(); });

describe("Archive thread button", () => {
  it("is a real, labelled button in the tab order", () => {
    mount(bot());
    const el = button();
    expect(el.tagName).toBe("BUTTON");
    expect(el.type).toBe("button");
    expect(el.tabIndex).toBe(0);
    expect(el.title).toBe(t("chat.archiveThread"));
    expect(el.getAttribute("aria-label")).toBe(t("chat.archiveThreadAria", { title: "Quarterly report" }));
    expect(el.getAttribute("aria-disabled")).toBeNull();
    expect(el.className).toContain("focus-visible:");
  });

  it("asks first, with Cancel focused, and archives nothing until confirmed", () => {
    mount(bot());
    click(button());
    expect(dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain(t("chat.archiveThreadTitle"));
    expect(dialog()!.textContent).toContain("Quarterly report");
    expect(document.activeElement?.textContent).toBe("Cancel");
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("Escape and Cancel leave the thread alone and return focus to the button", () => {
    mount(bot());
    button().focus();
    click(button());
    flushSync(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(button());
    click(button());
    click([...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find((b) => b.textContent === "Cancel")!);
    expect(dialog()).toBeNull();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("confirming dispatches the sidebar's own archive action for the current thread, then moves to the next one", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1234);
    mount(bot());
    click(button());
    click(document.querySelector<HTMLButtonElement>('[role="alertdialog"] button:last-of-type')!);
    expect(fixture.dispatch.mock.calls).toEqual([
      [{ type: "updateTask", botId: "bot", threadId: "current", patch: { archivedAt: 1234 } }],
      [{ type: "switchTask", botId: "bot", threadId: "older" }],
    ]);
    now.mockRestore();
  });

  it("starts a fresh thread when the archived one was the only open thread", () => {
    mount(bot({ tasks: [{ threadId: "current", title: "Only", createdAt: 1, activity: "idle" }] }));
    click(button());
    click(document.querySelector<HTMLButtonElement>('[role="alertdialog"] button:last-of-type')!);
    expect(fixture.dispatch.mock.calls.map(([action]) => action.type)).toEqual(["updateTask", "newTask"]);
    expect(fixture.dispatch.mock.calls[1]![0]).toEqual({ type: "newTask", botId: "bot" });
  });

  it("never archives a running thread: the button says why and ignores clicks", () => {
    for (const running of [
      bot({ busy: true }),
      bot({ tasks: [{ threadId: "current", title: "Running", createdAt: 1, busy: true }] }),
      bot({ tasks: [{ threadId: "current", title: "Running", createdAt: 1, activity: "working" }] }),
    ]) {
      mount(running);
      const el = button();
      expect(el.getAttribute("aria-disabled")).toBe("true");
      expect(el.title).toBe(t("chat.archiveThreadRunning"));
      expect(el.tabIndex).toBe(0);
      click(el);
      expect(dialog()).toBeNull();
    }
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("renders nothing for a thread that is already archived", () => {
    const markup = renderToStaticMarkup(createElement(ArchiveThreadButton, { bot: bot({ threadId: "put-away" }) }));
    expect(markup).toBe("");
  });
});

describe("archiveThreadDestination", () => {
  it("picks the most recent other thread that is not archived", () => {
    expect(archiveThreadDestination(bot())).toBe("older");
  });
  it("is null when nothing else is open", () => {
    expect(archiveThreadDestination(bot({ tasks: [{ threadId: "current", title: "x", createdAt: 1 }] }))).toBeNull();
  });
});
