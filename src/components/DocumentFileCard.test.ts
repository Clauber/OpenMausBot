import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentFileCard } from "./DocumentFileCard";

const message = { threadId: "thread/one", messageId: "message two" };
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  const window = new Window();
  vi.stubGlobal("window", window);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(name: string, context = message) {
  await act(async () => root.render(createElement(DocumentFileCard, { path: `/workspace/${name}`, name, message: context })));
}

async function click(label: string) {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  await act(async () => button!.click());
}

describe("document cards", () => {
  it("renders Markdown as escaped readable source", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("# Notes\n<script>unsafe()</script>")));
    await render("brief.md");
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(document.querySelector("pre")?.textContent).toBe("# Notes\n<script>unsafe()</script>");
    expect(document.querySelector("dialog script")).toBeNull();
  });

  it("shows an empty text file without treating it as loading", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("")));
    await render("notes.txt");
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(document.querySelector("dialog")?.textContent).toContain("This file is empty.");
    expect(document.querySelector('[role="status"]')).toBeNull();
  });

  it.each(["known", "chunked"])("bounds a %s-length text response", async (mode) => {
    const body = new Uint8Array(1024 * 1024 + 1);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, mode === "known" ? { headers: { "content-length": String(body.length) } } : {})));
    await render("notes.txt");
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("too large to preview");
    expect(document.querySelector("pre")).toBeNull();
  });

  it("retries a failed text read and aborts it when closed", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 404 }))
      .mockResolvedValueOnce(new Response("Recovered"));
    vi.stubGlobal("fetch", fetcher);
    await render("notes.txt");
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("could not be opened");
    await act(async () => document.querySelector<HTMLButtonElement>("dialog div button")!.click());
    expect(document.querySelector("pre")?.textContent).toBe("Recovered");
    const signal = fetcher.mock.calls[1]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    await click("Close table");
    expect(signal?.aborted).toBe(true);
  });

  it("keeps folder listings and their known sizes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      name: "reports", entries: [{ name: "notes.txt", bytes: 2048, mime: "text/plain" }], truncated: false,
    }), { headers: { "x-openmausbot-folder": "1" } })));
    await render("reports");
    await click("Save a copy of reports");
    expect(host.querySelector("ul")?.textContent).toContain("notes.txt");
    expect(host.querySelector("ul")?.textContent).toContain("2 KB");
  });

  it("keeps legacy files unavailable without a request", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await act(async () => root.render(createElement(DocumentFileCard, { path: "/workspace/old.txt", name: "old.txt" })));
    expect(host.textContent).toContain("Unavailable");
    expect(host.querySelector("button")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["brief.md", "notes.txt", "metrics.csv", "report.html"])("opens %s from its primary target without saving", async (name) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(name.endsWith("csv") ? "name,value\na,1" : "Hello <script>unsafe()</script>"));
    vi.stubGlobal("fetch", fetcher);
    const download = vi.spyOn(document, "createElement");
    await render(name);
    expect(fetcher).not.toHaveBeenCalled();
    expect(host.querySelectorAll("button")).toHaveLength(2);
    expect(host.querySelector("button button")).toBeNull();
    const primary = host.querySelector<HTMLButtonElement>("button")!;
    primary.focus();
    await act(async () => primary.click());
    expect(document.querySelector("dialog")?.textContent).toContain(name);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(fetcher.mock.calls[0]).toEqual([
      "/api/threads/thread%2Fone/messages/message%20two/file",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ path: `/workspace/${name}` }) }),
    ]);
    await vi.waitFor(() => expect(document.querySelector('[role="status"]')).toBeNull());
    expect(download.mock.calls.some(([tag]) => tag === "a")).toBe(false);
    await click("Close table");
    expect(document.querySelector("dialog")).toBeNull();
    expect(document.activeElement).toBe(primary);
  });

  it.each(["report.pdf", "archive.zip", "unknown"])("labels %s as save-only without an empty preview", async (name) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await render(name);
    expect(host.textContent).toContain("Save only");
    expect(host.querySelectorAll("button")).toHaveLength(1);
    expect(host.querySelector("button")?.getAttribute("aria-label")).toBe(`Save a copy of ${name}`);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("shows the type without requesting or guessing a size", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await render("metrics.csv");
    expect(host.textContent).toContain("CSV");
    expect(host.textContent).not.toMatch(/\b[KMGT]?B\b/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps workspace refusals visible on secondary save", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "outside", code: "outside_workspace" }), { status: 403 })));
    await render("notes.txt");
    await click("Save a copy of notes.txt");
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain("outside"));
    expect(host.querySelector('[aria-label="Retry saving notes.txt"]')).toBeNull();
  });
});
