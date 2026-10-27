// LEGION's side of the stealth engine contract: the snapshots the `stealth-browser`
// package produces must parse in the decider exactly as agent-browser's own do.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Browser, type BrowserContext } from "patchright";
import { StealthBrowserEngine, toAgentSnapshot } from "stealth-browser/engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseSnapshot } from "./decider/browser-click.ts";

// patchright 1.59 `page.ariaSnapshot({ mode: "ai" })` of a small contact form.
const ARIA = `- generic [active] [ref=e1]:
  - heading "Contact" [level=1] [ref=e2]
  - link "About us" [ref=e3] [cursor=pointer]:
    - /url: /about
  - generic [ref=e5]:
    - generic [ref=e6]:
      - text: Email
      - textbox "Email" [ref=e7]
    - generic [ref=e8]:
      - checkbox "Agree" [ref=e9]
      - text: Agree
    - generic [ref=e10]:
      - text: Size
      - combobox "Size" [ref=e11]:
        - option "Small" [selected]
        - option "Large"
    - button "Send message" [ref=e12]
  - paragraph [ref=e13]: idle
  - navigation "Site" [ref=e16]:
    - link "X" [ref=e17] [cursor=pointer]:
      - /url: /x
  - checkbox "On" [checked] [ref=e28]
  - 'button "Price: $5 # off" [ref=e30]'
  - paragraph [ref=e31]: "Text: with colon"
  - heading "Sub \\"quoted\\"" [level=2] [ref=e35]
  - iframe [ref=e36]:
    - button "Inner" [ref=f1e2]`;

describe("agent-browser snapshot format", () => {
  it("parses in the decider exactly as agent-browser's own snapshot does", () => {
    const elements = parseSnapshot(toAgentSnapshot(ARIA, {}));
    expect(elements.map(({ ref, role, name, states }) => ({ ref, role, name, states }))).toEqual([
      { ref: "e3", role: "link", name: "About us", states: [] },
      { ref: "e7", role: "textbox", name: "Email", states: [] },
      { ref: "e9", role: "checkbox", name: "Agree", states: ["checked=false"] },
      { ref: "e11", role: "combobox", name: "Size", states: ["expanded=false"] },
      { ref: "e12", role: "button", name: "Send message", states: [] },
      { ref: "e17", role: "link", name: "X", states: [] },
      { ref: "e28", role: "checkbox", name: "On", states: ["checked=true"] },
      { ref: "e30", role: "button", name: "Price: $5 # off", states: [] },
    ]);
    expect(elements.find((element) => element.ref === "e17")?.context).toBe("Site");
    expect(elements.find((element) => element.ref === "e7")?.heading).toBe("Contact");
  });
});

const CHROME = process.env.OMB_TEST_CHROME ?? "/opt/google/chrome/chrome";
const SNAPSHOTS = JSON.parse(readFileSync(new URL("./decider/fixtures/browser-snapshots.json", import.meta.url), "utf8")) as { signIn: string };

// The page the decider's agent-browser fixture `signIn` was captured from, rebuilt.
const SIGN_IN = `<title>Sign in</title><nav><a href="#">Home</a> <a href="#">Shop</a> <a href="#">Help</a></nav>
    <h1>Welcome back</h1><form><label>Email address <input type="email"></label><label>Password <input type="password"></label>
    <label><input type="checkbox"> Remember me</label><button type="button">Sign in</button><button type="button">Cancel</button></form>
    <h2>Results</h2><a href="#1">First result: Blue widgets</a> <a href="#2">Second result: Red gadgets</a>
    <label>Sort by <select><option>Newest</option><option>Price</option></select></label><button aria-label="Open cart">🛒</button>`;

type Result = { content: Array<{ type: "text"; text: string }>; isError: boolean };
const textOf = (result: Result) => result.content.map((part) => part.text).join("\n");

describe.skipIf(!existsSync(CHROME))("stealth browser engine", () => {
  let browser: Browser;
  let server: Server;
  let base: string;
  let context: BrowserContext;
  let engine: StealthBrowserEngine;
  let screenshotDir: string;
  const ok = async (tool: string, args: Record<string, unknown> = {}) => {
    const result = await engine.call(`agent_browser_${tool}`, args) as Result;
    expect(result.isError, `${tool}: ${textOf(result)}`).toBe(false);
    return textOf(result);
  };

  beforeAll(async () => {
    server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(SIGN_IN);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true, executablePath: CHROME });
    context = await browser.newContext();
    screenshotDir = mkdtempSync(join(tmpdir(), "omb-stealth-contract-"));
    engine = new StealthBrowserEngine(context, { screenshotDir });
  });
  afterAll(async () => {
    await engine?.close();
    await context?.close();
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (screenshotDir) rmSync(screenshotDir, { recursive: true, force: true });
  });

  it("produces a snapshot the decider reads like agent-browser's own", async () => {
    await ok("open", { url: `${base}/signin` });
    // patchright gives options no refs and native selects no value; everything else must match.
    const comparable = (text: string) => parseSnapshot(text).filter((element) => element.role !== "option")
      .map(({ role, name, states, heading }) => ({ role, name, states, heading }));
    expect(comparable(await ok("snapshot", { compact: true }))).toEqual(comparable(SNAPSHOTS.signIn));
  });
});
