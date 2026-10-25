import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Browser, type BrowserContext } from "patchright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { parseSnapshot } from "../decider/browser-click.ts";
import { StealthBrowserEngine } from "./engine.ts";

const solverPages = vi.hoisted(() => new WeakSet<object>());
vi.mock("./challenge.ts", () => ({ isCloudflareShadowPage: (page: object) => solverPages.has(page) }));

const CHROME = process.env.OMB_TEST_CHROME ?? "/opt/google/chrome/chrome";
const SNAPSHOTS = JSON.parse(readFileSync(new URL("../decider/fixtures/browser-snapshots.json", import.meta.url), "utf8")) as { signIn: string };

const PAGES: Record<string, string> = {
  "/": `<title>Contact</title><h1>Contact</h1><a href="/about">About us</a> <a href="/about" target="_blank">Popup</a>
    <form><label>Email <input id="email"></label><label><input type="checkbox" id="agree"> Agree</label>
    <label>Size <select id="size"><option value="s">Small</option><option value="l">Large</option></select></label>
    <button type="button" onclick="out.textContent = 'sent ' + email.value + ' ' + agree.checked + ' ' + size.value">Send message</button></form>
    <p id="out">idle</p><div style="height: 4000px"></div>`,
  "/about": "<title>About</title><h1>About</h1><p>About page text</p>",
  "/hover": `<title>Hover</title><input type="file" id="file" multiple>
    <div id="menu" style="width: 200px; height: 50px" onmouseenter="tip.textContent = 'open'">Menu</div><p id="tip">closed</p>`,
  // Records at load time whether the identity script already ran.
  "/identity": `<title>Identity</title><p id="seen"></p><script>seen.textContent = "prepared " + Boolean(window.__prepared)</script>`,
  // Renders its header a second after the document is ready, as single-page apps do.
  "/late": `<title>Late</title><script>setTimeout(() => document.body.insertAdjacentHTML("afterbegin", "<header>Late header</header>"), 1000)</script>`,
  "/dialogs": `<title>Dialogs</title><button onclick="alert('hi'); out.textContent = 'confirmed ' + confirm('ok?') + ' ' + prompt('name?', 'Ann')">Ask</button>
    <p id="out">waiting</p><script>addEventListener("beforeunload", (event) => { event.preventDefault(); event.returnValue = ""; });</script>`,
  // The image request never answers, so the window load event never fires.
  "/hang": "<title>Never loads</title><h1>Hanging</h1><img src=\"/never\">",
  // The page the decider's agent-browser fixture `signIn` was captured from, rebuilt.
  "/signin": `<title>Sign in</title><nav><a href="#">Home</a> <a href="#">Shop</a> <a href="#">Help</a></nav>
    <h1>Welcome back</h1><form><label>Email address <input type="email"></label><label>Password <input type="password"></label>
    <label><input type="checkbox"> Remember me</label><button type="button">Sign in</button><button type="button">Cancel</button></form>
    <h2>Results</h2><a href="#1">First result: Blue widgets</a> <a href="#2">Second result: Red gadgets</a>
    <label>Sort by <select><option>Newest</option><option>Price</option></select></label><button aria-label="Open cart">🛒</button>`,
};

type Result = { content: Array<{ type: "text"; text: string }>; isError: boolean };
const textOf = (result: Result) => result.content.map((part) => part.text).join("\n");

describe.skipIf(!existsSync(CHROME))("stealth browser engine", () => {
  let browser: Browser;
  let server: Server;
  let base: string;
  const hanging: ServerResponse[] = [];
  let context: BrowserContext;
  let engine: StealthBrowserEngine;
  let screenshotDir: string;
  const call = async (tool: string, args: Record<string, unknown> = {}) => engine.call(`agent_browser_${tool}`, args) as Promise<Result>;
  const ok = async (tool: string, args: Record<string, unknown> = {}) => {
    const result = await call(tool, args);
    expect(result.isError, `${tool}: ${textOf(result)}`).toBe(false);
    return textOf(result);
  };

  beforeAll(async () => {
    server = createServer((request: IncomingMessage, response: ServerResponse) => {
      if (request.url === "/never") { hanging.push(response); return; }
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(PAGES[request.url ?? "/"] ?? "<title>Missing</title>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true, executablePath: CHROME });
  });
  afterAll(async () => {
    for (const response of hanging) response.destroy();
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(async () => {
    context = await browser.newContext();
    screenshotDir = mkdtempSync(join(tmpdir(), "omb-stealth-engine-"));
    engine = new StealthBrowserEngine(context, { screenshotDir });
  });
  afterEach(async () => {
    await engine.close();
    await context.close();
    rmSync(screenshotDir, { recursive: true, force: true });
  });

  it("opens a page, snapshots it and acts on its refs", async () => {
    expect(await ok("open", { url: `${base}/` })).toBe("Contact");
    const snapshot = await ok("snapshot");
    expect(snapshot).toMatch(/^- heading "Contact" \[level=1, ref=e\d+\]$/m);
    const refs = Object.fromEntries(parseSnapshot(snapshot).map((element) => [element.name, element.ref]));
    expect(Object.keys(refs)).toEqual(expect.arrayContaining(["Email", "Agree", "Size", "Send message"]));

    await ok("fill", { selector: `@${refs.Email}`, text: "ann@example.com" });
    await ok("check", { selector: refs.Agree });
    await ok("select", { selector: `@${refs.Size}`, values: ["Large"] });
    await ok("click", { selector: `@${refs["Send message"]}` });
    expect(await ok("get_text", { selector: "#out" })).toBe("sent ann@example.com true l");

    await ok("uncheck", { selector: "#agree" });
    await ok("type", { selector: "#email", text: "!", clear: false });
    await ok("press", { key: "Tab" });
    await ok("click", { selector: "button" });
    expect(await ok("get_text", { selector: "#out" })).toBe("sent ann@example.com! false l");

    const missing = await call("click", { selector: "#nope" });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("Element not found: #nope");
    expect((await call("click", { selector: "@e999" })).isError).toBe(true);
  });

  it("puts files into a file input and hovers an element", async () => {
    const file = join(screenshotDir, "cv.txt");
    writeFileSync(file, "hello");
    await ok("open", { url: `${base}/hover` });
    await ok("upload", { selector: "#file", files: [file] });
    expect(await ok("eval", { script: "file.files[0].name + ' ' + file.files.length" })).toBe(JSON.stringify("cv.txt 1"));
    expect((await call("upload", { selector: "#file", files: [] })).isError).toBe(true);
    expect(textOf(await call("upload", { selector: "#missing", files: [file] }))).toContain("Element not found: #missing");
    await ok("hover", { selector: "#menu" });
    expect(await ok("get_text", { selector: "#tip" })).toBe("open");
  });

  it("scopes, limits and decorates snapshots", async () => {
    await ok("open", { url: `${base}/` });
    const scoped = await ok("snapshot", { selector: "form" });
    expect(scoped).toContain("textbox \"Email\"");
    expect(scoped).not.toContain("Contact");
    expect(await ok("snapshot", { includeUrls: true })).toContain(`url=${base}/about`);
    expect(await ok("snapshot", { interactive: false, compact: true })).toContain("- paragraph");
    expect(await ok("snapshot", { interactive: false, depth: 0 })).not.toMatch(/^ /m);
  });

  it("produces a snapshot the decider reads like agent-browser's own", async () => {
    await ok("open", { url: `${base}/signin` });
    // patchright gives options no refs and native selects no value; everything else must match.
    const comparable = (text: string) => parseSnapshot(text).filter((element) => element.role !== "option")
      .map(({ role, name, states, heading }) => ({ role, name, states, heading }));
    expect(comparable(await ok("snapshot", { compact: true }))).toEqual(comparable(SNAPSHOTS.signIn));
  });

  it("reads, evaluates, waits, scrolls and navigates history", async () => {
    await ok("open", { url: `${base}/` });
    const read = await ok("read");
    expect(read).toMatch(/^# Contact$/m);
    expect(read).toContain("idle");
    expect(await ok("read", { url: `${base}/about`, outline: true })).toBe("# About");
    expect(await ok("get_url")).toBe(`${base}/about`);
    expect(await ok("back")).toBe(`${base}/`);
    expect(await ok("forward")).toBe(`${base}/about`);
    expect(await ok("reload")).toBe(`${base}/about`);
    await ok("back");

    expect(await ok("eval", { script: "1 + 1" })).toBe("2");
    expect(await ok("eval", { script: "document.title" })).toBe("\"Contact\"");
    expect(JSON.parse(await ok("eval", { script: "({ a: 1 })" }))).toEqual({ a: 1 });
    const thrown = await call("eval", { script: "throw new Error('boom')" });
    expect(thrown.isError).toBe(true);
    expect(textOf(thrown)).toContain("Evaluation error: Error: boom");

    await ok("scroll", { direction: "down", amount: 500 });
    expect(Number(await ok("eval", { script: "scrollY" }))).toBeGreaterThan(0);
    await ok("wait_ms", { ms: 20 });
    await ok("wait_for_selector", { selector: "#out" });
    expect(await ok("wait_for_text", { text: "idle" })).toBe("idle");
    await ok("wait_for_load", { state: "load" });
    expect(await ok("get_title")).toBe("Contact");

    await ok("eval", { script: `location.assign(${JSON.stringify(`${base}/about`)})` });
    await ok("wait_ms", { ms: 300 });
    expect(await ok("get_title")).toBe("About");
  });

  it("saves screenshots in its own directory and lists its profile", async () => {
    await ok("open", { url: `${base}/` });
    const path = await ok("screenshot", { path: "/etc/omb-should-not-write.png" });
    expect(path.startsWith(screenshotDir)).toBe(true);
    expect(statSync(path).size).toBeGreaterThan(0);
    const jpeg = await ok("screenshot", { format: "jpeg", quality: 50, selector: "h1" });
    expect(jpeg).toMatch(/\.jpeg$/);
    expect(await ok("tools_profiles")).toContain("core");
    expect((await engine.call("agent_browser_nope", {})).isError).toBe(true);
  });

  it("gives tabs stable ids and moves the active tab only on a tab command", async () => {
    await ok("open", { url: `${base}/` });
    await ok("click", { selector: "a[target]" });
    await expect.poll(async () => JSON.parse(await ok("tab_list")).tabs.length).toBe(2);
    const listed = JSON.parse(await ok("tab_list")) as { tabs: Array<{ tabId: string; active: boolean; url: string; label: string | null }> };
    expect(listed.tabs.map((tab) => [tab.tabId, tab.active])).toEqual([["t1", true], ["t2", false]]);
    expect(await ok("get_url")).toBe(`${base}/`);

    expect(await ok("tab_new", { url: `${base}/about`, label: "docs" })).toBe(`${base}/about`);
    expect(await ok("get_title")).toBe("About");
    expect(await ok("tab_switch", { tab: "t1" })).toBe("Contact");
    await ok("tab_switch", { tab: "docs" });
    expect(await ok("get_url")).toBe(`${base}/about`);
    await ok("tab_close", { tab: "t2" });
    await ok("tab_close");
    const remaining = JSON.parse(await ok("tab_list")) as { tabs: Array<{ tabId: string; active: boolean }> };
    expect(remaining.tabs).toEqual([expect.objectContaining({ tabId: "t1", active: true })]);

    await ok("click", { selector: "a[href='/about']", newTab: true });
    const reopened = JSON.parse(await ok("tab_list")) as { tabs: Array<{ tabId: string; active: boolean }> };
    expect(reopened.tabs.map((tab) => [tab.tabId, tab.active])).toEqual([["t1", false], ["t4", true]]);
    expect(await ok("get_title")).toBe("About");
    expect((await call("tab_switch", { tab: "t2" })).isError).toBe(true);
  });

  it("answers JS dialogs so they never block", async () => {
    await ok("open", { url: `${base}/dialogs` });
    await ok("click", { selector: "button" });
    expect(await ok("get_text", { selector: "#out" })).toBe("confirmed true Ann");
    // beforeunload armed after a user gesture: leaving must not stall.
    expect(await ok("open", { url: `${base}/about` })).toBe("About");
  });

  it("returns from a navigation whose load event never fires", async () => {
    const started = Date.now();
    expect(await ok("open", { url: `${base}/hang` })).toBe("Never loads");
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(await ok("get_text", { selector: "h1" })).toBe("Hanging");
  });

  it("fails a call on a page that closes under it, then carries on in a live tab", async () => {
    await ok("open", { url: `${base}/` });
    await ok("tab_new", { url: `${base}/about` });
    const pending = call("wait_for_selector", { selector: "#never", waitTimeoutMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await context.pages().find((page) => page.url().endsWith("/about"))!.close();
    const failed = await pending;
    expect(failed.isError).toBe(true);
    expect(await ok("get_url")).toBe(`${base}/`);

    await context.pages()[0]!.close();
    expect(await ok("get_url")).toBe("about:blank");
    expect(JSON.parse(await ok("tab_list")).tabs.map((tab: { tabId: string }) => tab.tabId)).toEqual(["t3"]);
  });

  it("bounds every call and serializes calls on one engine", async () => {
    await ok("open", { url: `${base}/` });
    const started = Date.now();
    const timedOut = await call("wait_for_selector", { selector: "#never", waitTimeoutMs: 300 });
    expect(timedOut.isError).toBe(true);
    expect(Date.now() - started).toBeLessThan(3_000);

    const order: string[] = [];
    await Promise.all([
      call("wait_ms", { ms: 300 }).then(() => order.push("wait")),
      call("get_url").then(() => order.push("url")),
    ]);
    expect(order).toEqual(["wait", "url"]);
  });

  it("returns from a script that never settles within its default timeout", async () => {
    await ok("open", { url: `${base}/` });
    const started = Date.now();
    const stuck = await call("eval", { script: "new Promise(() => {})" });
    expect(stuck.isError).toBe(true);
    expect(textOf(stuck)).toMatch(/timed out/i);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(await ok("get_title")).toBe("Contact");
  }, 40_000);

  it("closes its tabs but keeps the browser usable", async () => {
    await ok("open", { url: `${base}/` });
    await ok("tab_new", { url: `${base}/about` });
    await ok("close");
    expect(context.pages().map((page) => page.url())).toEqual(["about:blank"]);
    expect(await ok("open", { url: `${base}/about` })).toBe("About");
  });

  it("waits briefly for an element a page renders after opening, and still fails fast when it never comes", async () => {
    await ok("open", { url: `${base}/late` });
    expect(await ok("get_text", { selector: "header" })).toBe("Late header");
    const started = Date.now();
    const missing = await call("get_text", { selector: "#nowhere" });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toMatch(/Element not found: #nowhere/);
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  it("lets the session's identity settle on a tab before any document loads in it", async () => {
    const prepared = new StealthBrowserEngine(context, {
      screenshotDir,
      prepare: async (page) => {
        await new Promise((resolve) => setTimeout(resolve, 300)); // an install still in flight
        await page.addInitScript("window.__prepared = true");
      },
    });
    for (const [tool, args] of [["agent_browser_tab_new", { url: `${base}/identity` }], ["agent_browser_open", { url: `${base}/identity` }]] as const) {
      expect((await prepared.call(tool, args)).isError, tool).toBe(false);
      const seen = await prepared.call("agent_browser_get_text", { selector: "#seen" });
      expect(textOf(seen), tool).toBe("prepared true");
    }
    await prepared.close();
  });

  it("navigates only to web pages, never to files on this host", async () => {
    await ok("open", { url: `${base}/about` });
    for (const [tool, args] of [["open", { url: "file:///etc/hostname" }], ["read", { url: "file:///etc/hostname" }], ["tab_new", { url: "view-source:file:///etc/hostname" }]] as const) {
      const result = await call(tool, args);
      expect(result.isError, tool).toBe(true);
      expect(textOf(result)).toMatch(/only open http and https/);
    }
    expect(await ok("get_url")).toBe(`${base}/about`);
    expect(await ok("open", { url: "about:blank" })).toBe("about:blank");
  });

  it("opens one blank tab when the panel and a call both find none", async () => {
    await Promise.all([engine.livePage(), call("get_url")]);
    expect(context.pages()).toHaveLength(1);
  });

  it("leaves the Cloudflare solver's own shadow page out of its tabs", async () => {
    await ok("open", { url: `${base}/` });
    const shadow = await context.newPage();
    solverPages.add(shadow);
    await shadow.goto(`${base}/about`);
    const listed = JSON.parse(await ok("tab_list")) as { tabs: Array<{ url: string }> };
    expect(listed.tabs.map((tab) => tab.url)).toEqual([`${base}/`]);
    await shadow.close();
    expect(await ok("get_url")).toBe(`${base}/`);
  });
});

describe("stealth browser engine budget", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("never lets a model-supplied wait hold the session past the call ceiling", async () => {
    vi.useFakeTimers();
    const context = { pages: () => [], on: () => context, off: () => context } as unknown as BrowserContext;
    const engine = new StealthBrowserEngine(context, { screenshotDir: tmpdir() });
    let answered = false;
    const waiting = engine.call("agent_browser_wait_ms", { ms: 3_600_000 }).then((result) => { answered = true; return result; });
    await vi.advanceTimersByTimeAsync(110_000);
    expect(answered).toBe(true);
    expect((await waiting).isError).toBe(false);
  });

  it("answers within the time the runtime has left for the call", async () => {
    vi.useFakeTimers();
    const context = { pages: () => [], on: () => context, off: () => context } as unknown as BrowserContext;
    const engine = new StealthBrowserEngine(context, { screenshotDir: tmpdir() });
    let answered = false;
    const waiting = engine.call("agent_browser_wait_ms", { ms: 60_000 }, 5_000).then((result) => { answered = true; return result; });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(answered).toBe(true);
    expect((await waiting).isError).toBe(false);
  });
});
