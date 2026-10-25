import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Browser, type BrowserContext } from "patchright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TransportError } from "../browser-runtime.ts";
import { StealthBrowserClient } from "./client.ts";

const CHROME = process.env.OMB_TEST_CHROME ?? "/opt/google/chrome/chrome";

/** agent-browser 0.37.0 `mcp --tools core`, in its own order. */
const CORE_TOOLS = [
  "agent_browser_tools_profiles", "agent_browser_open", "agent_browser_read", "agent_browser_snapshot", "agent_browser_click",
  "agent_browser_fill", "agent_browser_type", "agent_browser_press", "agent_browser_check", "agent_browser_uncheck",
  "agent_browser_select", "agent_browser_scroll", "agent_browser_wait_ms", "agent_browser_wait_for_selector",
  "agent_browser_wait_for_text", "agent_browser_wait_for_load", "agent_browser_screenshot", "agent_browser_get_text",
  "agent_browser_get_url", "agent_browser_get_title", "agent_browser_eval", "agent_browser_close", "agent_browser_back",
  "agent_browser_forward", "agent_browser_reload", "agent_browser_tab_new", "agent_browser_tab_list", "agent_browser_tab_switch",
  "agent_browser_tab_close",
];

describe.skipIf(!existsSync(CHROME))("stealth browser client", () => {
  let browser: Browser;
  let context: BrowserContext;
  let screenshotDir: string;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: CHROME });
    context = await browser.newContext();
    screenshotDir = mkdtempSync(join(tmpdir(), "omb-stealth-client-"));
  });
  afterAll(async () => {
    await browser?.close();
    rmSync(screenshotDir, { recursive: true, force: true });
  });

  it("speaks MCP like the agent-browser transport it replaces", async () => {
    let closed = 0;
    const client = new StealthBrowserClient(Promise.resolve(context), { screenshotDir, onClose: () => closed++ });
    await client.ready;
    expect(await client.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } }))
      .toEqual(expect.objectContaining({ protocolVersion: "2024-11-05" }));

    const { tools } = await client.rpc("tools/list", {}) as { tools: Array<{ name: string; description: string; inputSchema: { required?: string[]; properties: Record<string, unknown> } }> };
    expect(tools.map((tool) => tool.name)).toEqual(CORE_TOOLS);
    const click = tools.find((tool) => tool.name === "agent_browser_click")!;
    expect(click.description).toBe("Click an element by @ref or CSS selector.");
    expect(click.inputSchema.required).toEqual(["selector"]);
    expect(Object.keys(click.inputSchema.properties)).toEqual(expect.arrayContaining(["selector", "newTab", "session"]));

    await context.pages()[0]?.close(); // whatever the context holds, the client finds or opens a tab
    expect(await client.rpc("tools/call", { name: "agent_browser_get_url", arguments: {} }))
      .toEqual({ content: [{ type: "text", text: "about:blank" }], isError: false });
    expect(await client.rpc("tools/call", { name: "agent_browser_open", arguments: { url: "data:text/html,<title>Hi</title>", session: "ignored" } }))
      .toEqual({ content: [{ type: "text", text: "Hi" }], isError: false });
    await expect(client.rpc("resources/list", {})).rejects.toThrow(/not found/);

    await client.stop();
    await client.stop();
    expect(closed).toBe(1);
    await expect(client.rpc("tools/call", { name: "agent_browser_get_url", arguments: {} })).rejects.toBeInstanceOf(TransportError);
  });

  it("stops itself when its browser context closes, so the runtime builds a fresh one", async () => {
    const own = await browser.newContext();
    let closed = 0;
    const client = new StealthBrowserClient(Promise.resolve(own), { screenshotDir, onClose: () => closed++ });
    expect(await client.rpc("tools/call", { name: "agent_browser_get_url", arguments: {} })).toEqual(expect.objectContaining({ isError: false }));
    await own.close();
    await expect.poll(() => closed).toBe(1);
    await expect(client.rpc("tools/call", { name: "agent_browser_get_url", arguments: {} })).rejects.toBeInstanceOf(TransportError);
  });

  it("fails ready when its browser never arrives", async () => {
    const client = new StealthBrowserClient(Promise.reject(new Error("no Chrome")), { screenshotDir });
    await expect(client.ready).rejects.toThrow("no Chrome");
    await expect(client.rpc("tools/list", {})).rejects.toBeInstanceOf(TransportError);
  });
});
