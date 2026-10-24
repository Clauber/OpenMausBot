// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

import { BotFolderBrowser } from "./BotFolderBrowser";

const listings: Record<string, unknown> = {
  "": { roots: ["/work/project", "/data/workspaces/scout"], root: 0, path: "", folders: ["renders"], entries: [{ name: "notes.md", bytes: 7, mime: "text/markdown; charset=utf-8" }], truncated: false },
  renders: { roots: ["/work/project", "/data/workspaces/scout"], root: 0, path: "renders", folders: [], entries: [{ name: "clip 1.mp4", bytes: 2048, mime: "video/mp4" }], truncated: false },
};

describe("BotFolderBrowser", () => {
  let root: Root;
  let container: HTMLDivElement;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    return new Response(JSON.stringify(listings[url.searchParams.get("path") ?? ""]), { status: 200 });
  });

  beforeEach(() => {
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
  const button = (label: string) => [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(label))!;

  it("walks into a folder and plays a video from the bot's folder", async () => {
    const bot = { id: "scout", threadId: "thread-1", name: "Scout", messages: [] } as unknown as Bot;
    act(() => root.render(createElement(BotFolderBrowser, { bot })));
    await settle();
    expect(String(fetchMock.mock.calls[0]![0])).toBe("/api/bots/scout/files?threadId=thread-1&root=0&path=");
    expect(container.textContent).toContain("notes.md");

    act(() => button("renders").click());
    await settle();
    expect(String(fetchMock.mock.calls.at(-1)![0])).toContain("path=renders");

    act(() => button("clip 1.mp4").click());
    const video = container.querySelector("video")!;
    expect(video.getAttribute("src")).toBe("/api/bots/scout/files/raw?threadId=thread-1&root=0&path=renders%2Fclip+1.mp4");

    act(() => button("renders").click());
    expect(container.querySelector("video")).toBeNull();
    expect(container.textContent).toContain("clip 1.mp4");
  });
});
