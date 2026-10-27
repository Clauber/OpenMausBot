// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, type Bot, type Group } from "@/state/store";
import { AllThreadsButton } from "./ChatAllThreads";

const fixture = vi.hoisted(() => ({ state: {} as typeof initialState, dispatch: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => fixture,
}));

const alpha: Bot = {
  id: "alpha", name: "Alpha", threadId: "alpha-new", color: "green", title: "", description: "",
  notifications: true, busy: false, unread: false, messages: [], modelSelection: { instanceId: "fake", model: "fake" },
  tasks: [
    { threadId: "alpha-new", title: "New Alpha thread", createdAt: 3 },
    { threadId: "alpha-reply", title: "Alpha reply", createdAt: 2, unread: true },
    { threadId: "alpha-quiet", title: "Alpha quiet history", createdAt: 1 },
    { threadId: "alpha-working", title: "Alpha working", createdAt: 4, busy: true, activity: "working" },
    { threadId: "alpha-waiting", title: "Alpha waiting", createdAt: 5, activity: "waiting-on-you" },
    { threadId: "alpha-queued", title: "Alpha queued", createdAt: 6 },
  ],
};
const beta: Bot = { ...alpha, id: "beta", name: "Beta", threadId: "beta-reply", tasks: [
  { threadId: "beta-reply", title: "Beta reply", createdAt: 4, unread: true },
  { threadId: "beta-working", title: "Beta working", createdAt: 5, busy: true },
  { threadId: "beta-waiting", title: "Beta waiting", createdAt: 6, activity: "waiting-on-you" },
  { threadId: "beta-quiet", title: "Beta quiet", createdAt: 7 },
  { threadId: "beta-queued", title: "Beta queued", createdAt: 8 },
] };
const group: Group = {
  id: "room", name: "Fixture room", threadId: "room-thread", memberIds: [],
  defaultResponder: { kind: "everyone" }, bulletin: "", createdAt: 1, unread: false, messages: [],
  tasks: [{ threadId: "room-thread", title: "Room history", createdAt: 5 }],
};

describe("chat header All threads", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    fixture.state = { ...initialState, bots: [alpha, beta], groups: [group], selectedId: alpha.id,
      pendingQueued: { "alpha-queued": [{ queueId: "alpha-queue", text: "Alpha next job" }],
        "beta-queued": [{ queueId: "beta-queue", text: "Beta next job" }] } };
    fixture.dispatch.mockClear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function open() {
    await act(async () => root.render(createElement(AllThreadsButton)));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="All threads"]')!.click());
    return host.querySelector<HTMLElement>('[role="menu"]')!;
  }

  it("opens only the displayed bot's threads and jumps to its exact sibling", async () => {
    const menu = await open();
    expect(menu.textContent).toContain("New Alpha thread");
    expect(menu.textContent).toContain("Alpha reply");
    expect(menu.textContent).toContain("Alpha quiet history");
    expect(menu.textContent).toContain("Alpha working");
    expect(menu.textContent).toContain("Alpha waiting");
    expect(menu.textContent).toContain("Alpha queued");
    expect(menu.textContent).not.toContain("Beta");
    expect(menu.textContent).not.toContain("Beta reply");
    expect(menu.textContent).not.toContain("Room history");
    const reply = [...menu.querySelectorAll<HTMLButtonElement>("button")].find((row) => row.textContent?.includes("Alpha reply"))!;
    await act(async () => reply.click());
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "switchTask", botId: "alpha", threadId: "alpha-reply" });
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });

  it("updates an open menu when the selected bot changes", async () => {
    await open();
    fixture.state = { ...fixture.state, selectedId: beta.id };
    await act(async () => root.render(createElement(AllThreadsButton)));
    const menu = host.querySelector('[role="menu"]')!;
    expect(menu.textContent).toContain("Beta reply");
    expect(menu.textContent).not.toContain("Alpha reply");
    expect(menu.textContent).not.toContain("Room history");
  });

  it("never falls back to other bots when the current bot is missing", async () => {
    fixture.state = { ...fixture.state, selectedId: "missing" };
    const menu = await open();
    expect(menu.textContent).not.toContain("Alpha reply");
    expect(menu.textContent).not.toContain("Beta reply");
    expect(menu.textContent).not.toContain("Room history");
  });
});
