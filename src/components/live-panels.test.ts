// @vitest-environment happy-dom
// The Inspector and Activity panels follow the app's one live stream. They
// open no stream of their own: runtime events reach them from the stream the
// store already holds, and a gap the stream could not replay reloads them.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "../../shared/runtime-events";
import type { AppState, Bot } from "@/state/store";

vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useCaptionChrome: () => ({ padClass: undefined }),
}));

const { InspectorPanel } = await import("./InspectorPanel");
const { ActivityPanel } = await import("./ActivityPanel");
const { BotEditorStore, initialState } = await import("@/state/store");
const { publishLiveFrame, publishMissedFrames } = await import("@/lib/live-events");

const opened = vi.fn();
class SpyEventSource {
  onopen = null;
  onerror = null;
  onmessage = null;
  constructor(url: string) { opened(url); }
  close() {}
}

const bot = {
  id: "bot", threadId: "thread", name: "Fixture", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [], modelSelection: { instanceId: "fake", model: "m" },
  tasks: [{ threadId: "thread", title: "Thread", createdAt: 1, approvalMode: "ask" }],
} as unknown as Bot;
const runtime = (eventId: string, fields: Record<string, unknown>, threadId = "thread") => ({
  eventId, provider: "codex", threadId, createdAt: "2026-10-04T09:00:00.000Z", ...fields,
}) as RuntimeEvent;
// How the store hands frames on; the panels hear nothing else.
const frame = (event: RuntimeEvent) => publishLiveFrame({ kind: "runtime", event });
const missed = () => publishMissedFrames();

const fetched: string[] = [];
let activityRows: unknown[] = [];
const dispatched = vi.fn();
let root: Root;
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
async function mount(panel: typeof InspectorPanel | typeof ActivityPanel) {
  const state: AppState = { ...initialState, bots: [bot], selectedId: bot.id };
  const value = { state, dispatch: dispatched, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root.render(createElement(BotEditorStore, { value, children: createElement(panel, { bot }) })));
  await settle();
}

beforeEach(() => {
  opened.mockClear();
  dispatched.mockClear();
  fetched.length = 0;
  activityRows = [];
  vi.stubGlobal("EventSource", SpyEventSource);
  vi.stubGlobal("fetch", (path: string) => {
    fetched.push(path);
    const body = path.startsWith("/api/threads/") ? { entries: [], total: { runtime: 0, native: 0 } } : { rows: activityRows };
    return Promise.resolve(new Response(JSON.stringify(body)));
  });
});
afterEach(() => {
  root.unmount();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("Inspector on the app's live stream", () => {
  it("shows this thread's runtime events and opens no stream of its own", async () => {
    await mount(InspectorPanel);
    const events = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === "events")!;
    flushSync(() => events.click());
    flushSync(() => {
      frame(runtime("e1", { type: "item.started", itemType: "tool", title: "List the files" }));
      frame(runtime("e2", { type: "item.started", itemType: "tool", title: "Somebody else's step" }, "other-thread"));
    });
    await settle();
    expect(document.body.textContent).toContain("tool: List the files");
    expect(document.body.textContent).not.toContain("Somebody else's step");
    expect(opened).not.toHaveBeenCalled();
  });

  it("reloads from disk when the stream missed frames it could not replay", async () => {
    await mount(InspectorPanel);
    expect(fetched.filter(path => path.includes("/events?"))).toEqual(["/api/threads/thread/events?limit=400"]);
    missed();
    await settle();
    expect(fetched.filter(path => path.includes("/events?"))).toEqual(["/api/threads/thread/events?limit=400", "/api/threads/thread/events?limit=400"]);
  });
});

describe("Activity on the app's live stream", () => {
  it("reloads when one of the bot's turns settles, with no stream of its own", async () => {
    await mount(ActivityPanel);
    expect(fetched).toEqual(["/api/bots/bot/activity?limit=300"]);
    frame(runtime("e3", { type: "turn.completed", ok: true }, "other-thread"));
    frame(runtime("e4", { type: "turn.completed", ok: true }));
    await new Promise((resolve) => setTimeout(resolve, 450));
    await settle();
    expect(fetched).toEqual(["/api/bots/bot/activity?limit=300", "/api/bots/bot/activity?limit=300"]);
    expect(opened).not.toHaveBeenCalled();
  });

  it("reloads when the stream missed frames it could not replay", async () => {
    await mount(ActivityPanel);
    missed();
    await settle();
    expect(fetched).toHaveLength(2);
  });
});

describe("Activity command details", () => {
  const activityBot = { ...bot, tasks: [...(bot.tasks ?? []), { threadId: "side", title: "Side", createdAt: 2, approvalMode: "ask" }] } as Bot;
  const row = (fields: Record<string, unknown>) => ({ at: "2026-10-04T09:00:00.000Z", threadId: "thread", turnId: "turn", tool: "Bash", app: null, label: "Ran a command", outcome: "running", ...fields });
  const mountActivity = async () => {
    const state: AppState = { ...initialState, bots: [activityBot], selectedId: activityBot.id };
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    flushSync(() => root.render(createElement(BotEditorStore, {
      value: { state, dispatch: dispatched, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} },
      children: createElement(ActivityPanel, { bot: activityBot }),
    })));
    await settle();
  };

  it("opens a running command's input in place, from the keyboard-focusable summary", async () => {
    activityRows = [row({ detail: { name: "Bash", input: "npm run build", itemId: "i1" } })];
    await mountActivity();
    const summary = document.querySelector<HTMLElement>('[data-testid="activity-row"] summary')!;
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    const details = summary.parentElement as HTMLDetailsElement;
    flushSync(() => { details.open = true; details.dispatchEvent(new Event("toggle")); });
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(details.textContent).toContain("npm run build");
    expect(details.textContent).toContain("Waiting for the tool to finish");
    expect(dispatched).not.toHaveBeenCalled();
  });

  it("shows a finished command's output and offers to open another task's chat", async () => {
    activityRows = [row({ threadId: "side", outcome: "failed", detail: { name: "Bash", input: "npm test", output: "1 failed", ok: false, itemId: "i2" } })];
    await mountActivity();
    const details = document.querySelector<HTMLDetailsElement>('[data-testid="activity-row"]')!;
    expect(details.textContent).toContain("1 failed");
    const open = details.querySelector<HTMLButtonElement>("button")!;
    flushSync(() => open.click());
    expect(dispatched).toHaveBeenCalledWith({ type: "switchTask", botId: "bot", threadId: "side" });
  });

  it("keeps a row with no chat message as the plain jump button", async () => {
    activityRows = [row({ outcome: "denied", summary: "rm -rf build" })];
    await mountActivity();
    expect(document.querySelector("details")).toBeNull();
    const line = document.querySelector('[data-testid="activity-row"]')!;
    expect(line.tagName).toBe("BUTTON");
    expect(line.textContent).toContain("rm -rf build");
  });

  it("still reloads when the bot's task list re-renders while the reload is pending", async () => {
    await mountActivity();
    frame(runtime("e6", { type: "item.completed", itemType: "tool", itemId: "i1", ok: true }));
    const state: AppState = { ...initialState, bots: [{ ...activityBot, tasks: [...(activityBot.tasks ?? [])] }], selectedId: activityBot.id };
    flushSync(() => root.render(createElement(BotEditorStore, {
      value: { state, dispatch: dispatched, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} },
      children: createElement(ActivityPanel, { bot: { ...activityBot, busy: true, tasks: [...(activityBot.tasks ?? [])] } as Bot }),
    })));
    await new Promise((resolve) => setTimeout(resolve, 450));
    await settle();
    expect(fetched).toHaveLength(2);
  });

  it("reloads when a command starts, so it shows while it runs", async () => {
    await mount(ActivityPanel);
    frame(runtime("e5", { type: "item.started", itemType: "tool", title: "Bash" }));
    await new Promise((resolve) => setTimeout(resolve, 450));
    await settle();
    expect(fetched).toHaveLength(2);
  });
});
