// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Message } from "@/state/store";

import { BotFolderBrowser } from "./BotFolderBrowser";

const roots = ["/home/me/work/project", "/data/workspaces/scout"];
const listing = (base: string, folders: string[], entries: Array<[string, string]>, canGoUp = true) => ({
  roots, base, canGoUp, folders, entries: entries.map(([name, mime]) => ({ name, bytes: 2048, mime })), truncated: false,
});
const folders: Record<string, unknown> = {
  "0:0:": listing("/home/me/work/project", ["renders"], [["notes.md", "text/markdown"]]),
  "0:0:renders": listing("/home/me/work/project", [], [["clip 1.mp4", "video/mp4"]]),
  "0:1:": listing("/home/me/work", ["project"], [], false),
  "0:1:project": listing("/home/me/work", ["renders"], [["notes.md", "text/markdown"]], false),
  "0:1:project/renders": listing("/home/me/work", [], [["clip 1.mp4", "video/mp4"]], false),
};

describe("BotFolderBrowser", () => {
  let root: Root;
  let container: HTMLDivElement;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const key = `${url.searchParams.get("root")}:${url.searchParams.get("up")}:${url.searchParams.get("path")}`;
    return folders[key] ? new Response(JSON.stringify(folders[key])) : new Response(JSON.stringify({ error: "nope" }), { status: 404 });
  });

  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    fetchMock.mockClear();
    vi.unstubAllGlobals();
  });

  const settle = () => act(async () => { await new Promise((done) => setTimeout(done, 0)); });
  const items = () => [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')];
  const item = (name: string) => items().find((candidate) => candidate.textContent?.startsWith(name))!;
  const labels = () => items().map((candidate) => `${candidate.getAttribute("aria-level")}:${candidate.textContent}`);
  const key = (target: HTMLElement, name: string) => act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })); });
  const makeBot = (messages: Message[] = []) => ({ id: "scout", threadId: "thread-1", name: "Scout", cwd: roots[0], messages }) as unknown as Bot;

  it("expands folders in place, opens a video beside the tree, and climbs without losing what was open", async () => {
    act(() => root.render(createElement(BotFolderBrowser, { bot: makeBot() })));
    await settle();
    expect(labels()).toEqual(["1:project", "2:renders", "2:notes.md", "1:Shared folder"]);

    act(() => item("renders").click());
    await settle();
    expect(labels()).toEqual(["1:project", "2:renders", "3:clip 1.mp4", "2:notes.md", "1:Shared folder"]);

    act(() => item("clip 1.mp4").click());
    expect(container.querySelector("video")!.getAttribute("src")).toBe("/api/bots/scout/files/raw?threadId=thread-1&root=0&up=0&path=renders%2Fclip+1.mp4");
    expect(item("clip 1.mp4").getAttribute("aria-selected")).toBe("true");

    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Up one folder"]')!.click());
    await settle();
    expect(labels()).toEqual(["1:work", "2:project", "3:renders", "4:clip 1.mp4", "3:notes.md", "1:Shared folder"]);
    expect(container.querySelector("video")!.getAttribute("src")).toContain("up=1&path=project%2Frenders%2Fclip+1.mp4");
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Up one folder"]')!.disabled).toBe(true);
  });

  it("moves through the tree with the arrow keys and opens with Enter", async () => {
    act(() => root.render(createElement(BotFolderBrowser, { bot: makeBot() })));
    await settle();
    const tree = container.querySelector<HTMLElement>('[role="tree"]')!;
    expect(items().filter((candidate) => candidate.tabIndex === 0).map((candidate) => candidate.textContent)).toEqual(["project"]);

    key(tree, "ArrowDown");
    expect(document.activeElement).toBe(item("renders"));
    key(tree, "ArrowRight");
    await settle();
    expect(item("renders").getAttribute("aria-expanded")).toBe("true");
    key(tree, "ArrowRight");
    expect(document.activeElement).toBe(item("clip 1.mp4"));
    key(tree, "Enter");
    expect(container.querySelector("video")).not.toBeNull();
    key(tree, "ArrowLeft");
    expect(document.activeElement).toBe(item("renders"));
    key(tree, "ArrowLeft");
    expect(item("renders").getAttribute("aria-expanded")).toBe("false");
  });

  it("re-lists expanded folders every few seconds only while the bot is working", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const working = { ...makeBot(), busy: true } as Bot;
      act(() => root.render(createElement(BotFolderBrowser, { bot: working })));
      await settle();
      const before = fetchMock.mock.calls.length;
      await act(async () => { vi.advanceTimersByTime(3_000); });
      await settle();
      expect(fetchMock.mock.calls.length).toBe(before + 1);

      act(() => root.render(createElement(BotFolderBrowser, { bot: { ...working, busy: false } as Bot })));
      await act(async () => { vi.advanceTimersByTime(9_000); });
      expect(fetchMock.mock.calls.length).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks files this chat added or changed, and the folders holding them", async () => {
    const digest = { id: "d1", role: "bot", kind: "digest", at: 1, digest: { files: { added: ["renders/clip 1.mp4"], changed: ["/home/me/work/project/notes.md"], deleted: [] } } } as unknown as Message;
    act(() => root.render(createElement(BotFolderBrowser, { bot: makeBot([digest]) })));
    await settle();
    expect(item("notes.md").textContent).toBe("notes.mdM");
    expect(item("renders").querySelector('[title="Has files changed in this chat"]')).not.toBeNull();
  });
});
