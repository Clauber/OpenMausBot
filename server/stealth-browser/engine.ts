// agent-browser's core tools, served in-process on the stealth runtime's own
// patchright BrowserContext. agent-browser's daemon wedged on heavy pages
// (its CDP event buffer overflowed and its own calls timed out while Chrome
// answered in milliseconds); this engine keeps the same tool names, argument
// schemas and result text, so nothing upstream changes.
//
// Every call is serialized and bounded: a call that outlives its budget
// returns an error and the next call runs, whatever the page is still doing.
// The runtime owns Chrome and the context; this engine only opens and closes
// tabs in it.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { BrowserContext, Dialog, Frame, Locator, Page } from "patchright";

import { isCloudflareShadowPage } from "./challenge.ts";
import { toAgentSnapshot } from "./snapshot.ts";

export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError: boolean };
/** A tab as the Browser panel lists it. */
export interface TabInfo { tabId: string; label: string | null; title: string; url: string; active: boolean }
type Args = Record<string, unknown>;
type Tool = (args: Args, timeout: number) => Promise<string>;

interface Tab {
  id: string;
  page: Page;
  label?: string;
}

const CALL_TIMEOUT_MS = 25_000;
/** No call, whatever wait the model asks for, holds the session longer: under BrowserRuntime's 120s transport timeout. */
const MAX_CALL_MS = 110_000;
/** Lets patchright's own timeout, with its clearer message, win the race. */
const RACE_SLACK_MS = 1_000;
/** After domcontentloaded, how long `open` waits for load before answering anyway. */
const SETTLE_MS = 2_000;
const TAB_TITLE_MS = 1_000;
/** How long an element a page has not rendered yet may take to appear before it counts as missing. */
const ATTACH_GRACE_MS = 5_000;
const PROFILES_TEXT = "Active MCP tools profile(s): core\n\nThis browser serves the core profile only: 29 tools for navigation, snapshots, common interaction, waits, screenshots, basic reads, tab basics, JavaScript eval and close.";

const SCROLL_DIRECTIONS: Readonly<Record<string, readonly [number, number]>> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

class CallTimeout extends Error {}

function stringArg(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value) throw new Error(`${key} is required.`);
  return value;
}

const optionalString = (args: Args, key: string): string | undefined => typeof args[key] === "string" && args[key] ? args[key] as string : undefined;
const numberArg = (args: Args, key: string): number | undefined => typeof args[key] === "number" && Number.isFinite(args[key]) ? args[key] as number : undefined;
const json = (value: unknown): string => JSON.stringify(value, null, 2);

/** patchright prefixes errors with the API call (`locator.click: ...`) and
 * appends a call log; the first line without the prefix is the message. */
function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^[\w.]+: /, "").split("\nCall log:")[0]!.trim() || "The browser action failed.";
}

function withUrlScheme(url: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) && !/^[^:/]+:\d/.test(url) ? url : `https://${url}`;
}

/** Bots browse the web: a file:, view-source: or chrome: URL would show them this host instead. */
function webUrl(url: string): string {
  const target = withUrlScheme(url);
  if (target !== "about:blank" && !/^(?:https?:\/\/|data:)/i.test(target)) throw new Error(`The browser can only open http and https pages, not ${target.split(":")[0]}: URLs.`);
  return target;
}

/** Give a navigated page a moment to finish loading, never longer. */
const settle = (page: Page): Promise<void> => page.waitForLoadState("load", { timeout: SETTLE_MS }).catch(() => {});

function bounded<T>(work: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  work.catch(() => {}); // a call that already timed out may still fail later
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CallTimeout(`${name} timed out after ${ms}ms. The page may still be busy: check it with agent_browser_get_url or agent_browser_snapshot before repeating the action.`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Runs in the page (source text: the server has no DOM types): the page as
 * readable text, headings as markdown and everything else as rendered. */
const READ_PAGE = `(({ outline, raw }) => {
  if (raw) return document.documentElement.outerHTML;
  const headings = new Map();
  for (const heading of document.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    const text = heading.innerText.trim();
    if (text && !headings.has(text)) headings.set(text, "#".repeat(Number(heading.tagName[1])));
  }
  const lines = (document.body?.innerText ?? "").split("\\n").map((line) => line.trim());
  const marked = lines.map((line) => headings.has(line) ? headings.get(line) + " " + line : line);
  const kept = outline ? marked.filter((line) => line.startsWith("#")) : marked;
  return kept.join("\\n").replace(/\\n{3,}/g, "\\n\\n").trim();
})`;

export class StealthBrowserEngine {
  private readonly context: BrowserContext;
  private readonly screenshotDir: string;
  private readonly log?: (line: string) => void;
  /** Resolves once the session's identity is installed on a page, before any document loads in it. */
  private readonly prepare?: (page: Page) => Promise<void>;
  /** In tab-id order; a closed or crashed page leaves at once. */
  private tabs: Tab[] = [];
  private active?: Tab;
  private nextTab = 1;
  /** The blank tab being opened because none was left, shared so the panel and a call never open one each. */
  private opening?: Promise<Tab>;
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private readonly listeners = new Set<() => void>();
  private readonly tools: Record<string, Tool>;

  constructor(context: BrowserContext, options: { screenshotDir: string; log?: (line: string) => void; prepare?: (page: Page) => Promise<void> }) {
    this.context = context;
    this.screenshotDir = options.screenshotDir;
    this.log = options.log;
    this.prepare = options.prepare;
    for (const page of context.pages()) this.adopt(page);
    context.on("page", this.adopt);
    context.on("dialog", this.answerDialog);
    this.tools = {
      agent_browser_tools_profiles: async () => PROFILES_TEXT,
      agent_browser_open: async (args, timeout) => {
        const url = optionalString(args, "url");
        const page = await this.page();
        if (url) await this.navigate(page, url, timeout);
        return await page.title() || page.url();
      },
      agent_browser_read: async (args, timeout) => {
        const page = await this.page();
        const url = optionalString(args, "url");
        if (url) await this.navigate(page, url, timeout);
        if (args.requireMd === true) {
          const type = await page.evaluate("document.contentType");
          if (type !== "text/markdown") throw new Error(`The page is ${String(type)}, not text/markdown.`);
        }
        return String(await page.evaluate(`${READ_PAGE}(${JSON.stringify({ outline: args.outline === true, raw: args.raw === true })})`));
      },
      agent_browser_snapshot: async (args, timeout) => {
        const page = await this.page();
        const selector = optionalString(args, "selector");
        const scope = selector ? await this.locate(page, selector) : page;
        const aria = await scope.ariaSnapshot({ mode: "ai", timeout });
        const interactive = args.interactive !== false;
        const text = toAgentSnapshot(aria, {
          interactive, compact: args.compact === true, depth: numberArg(args, "depth"), includeUrls: args.includeUrls === true, baseUrl: page.url(),
        });
        return text || (interactive ? "(no interactive elements)" : "(empty page)");
      },
      agent_browser_click: async (args, timeout) => {
        const selector = stringArg(args, "selector");
        const element = await this.locate(await this.page(), selector);
        if (args.newTab !== true) {
          await element.click({ timeout });
          return json({ clicked: selector });
        }
        const href = await element.evaluate((node: unknown) => (node as { closest(selector: string): { href: string } | null }).closest("a")?.href ?? null, undefined, { timeout });
        if (!href) throw new Error(`${selector} is not a link, so it cannot open in a new tab.`);
        const tab = this.adopt(await this.context.newPage());
        this.active = tab;
        await this.navigate(tab.page, href, timeout);
        return json({ clicked: selector, tabId: tab.id });
      },
      agent_browser_fill: async (args, timeout) => {
        const selector = stringArg(args, "selector");
        await (await this.locate(await this.page(), selector)).fill(String(args.text ?? ""), { timeout });
        return json({ filled: selector });
      },
      agent_browser_type: async (args, timeout) => {
        const text = String(args.text ?? "");
        const element = await this.locate(await this.page(), stringArg(args, "selector"));
        if (args.clear === true) await element.fill("", { timeout });
        else await element.press("End", { timeout }); // type after what the field already holds
        await element.pressSequentially(text, { delay: numberArg(args, "delayMs"), timeout });
        return json({ typed: text });
      },
      agent_browser_press: async (args) => {
        const key = stringArg(args, "key");
        await (await this.page()).keyboard.press(key);
        return json({ pressed: key });
      },
      agent_browser_check: async (args, timeout) => {
        const selector = stringArg(args, "selector");
        await (await this.locate(await this.page(), selector)).check({ timeout });
        return json({ checked: selector });
      },
      agent_browser_uncheck: async (args, timeout) => {
        const selector = stringArg(args, "selector");
        await (await this.locate(await this.page(), selector)).uncheck({ timeout });
        return json({ unchecked: selector });
      },
      agent_browser_select: async (args, timeout) => {
        const values = Array.isArray(args.values) ? args.values.map(String) : [];
        if (!values.length) throw new Error("values is required.");
        // patchright matches each value against both option values and labels.
        await (await this.locate(await this.page(), stringArg(args, "selector"))).selectOption(values, { timeout });
        return json({ selected: values });
      },
      agent_browser_scroll: async (args, timeout) => {
        const amount = numberArg(args, "amount") ?? 300;
        const [x, y] = SCROLL_DIRECTIONS[optionalString(args, "direction") ?? "down"] ?? SCROLL_DIRECTIONS.down!;
        const [dx, dy] = [x * amount, y * amount];
        const page = await this.page();
        const selector = optionalString(args, "selector");
        if (selector) {
          await (await this.locate(page, selector)).evaluate((node: unknown, [x, y]) => (node as { scrollBy(x: number, y: number): void }).scrollBy(x!, y!), [dx, dy], { timeout });
        } else {
          // A wheel over the middle of the viewport scrolls whatever pane is there, as a person would.
          const [width, height] = await page.evaluate("[innerWidth, innerHeight]") as [number, number];
          await page.mouse.move(width / 2, height / 2);
          await page.mouse.wheel(dx, dy);
          // The wheel returns before the page scrolls; two frames later the next call sees the new position.
          await page.evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
        }
        return json({ scrolled: true });
      },
      agent_browser_wait_ms: async (args, timeout) => {
        const ms = Math.min(numberArg(args, "ms") ?? 0, timeout);
        await new Promise((resolve) => setTimeout(resolve, ms));
        return json({ ms, waited: "timeout" });
      },
      agent_browser_wait_for_selector: async (args, timeout) => {
        const selector = stringArg(args, "selector");
        await this.locator(await this.page(), selector).waitFor({ state: "visible", timeout });
        return json({ selector, waited: "selector" });
      },
      agent_browser_wait_for_text: async (args, timeout) => {
        const text = stringArg(args, "text");
        await (await this.page()).getByText(text).first().waitFor({ state: "visible", timeout });
        return text;
      },
      agent_browser_wait_for_load: async (args, timeout) => {
        const state = optionalString(args, "state");
        if (state !== "load" && state !== "domcontentloaded" && state !== "networkidle") throw new Error("state must be load, domcontentloaded or networkidle.");
        const page = await this.page();
        // A page restored from the back/forward cache never reports load again; its readyState still does.
        const ready = state !== "networkidle" && await page.evaluate("document.readyState") as string;
        if (ready !== "complete" && !(state === "domcontentloaded" && ready === "interactive")) await page.waitForLoadState(state, { timeout });
        return json({ state });
      },
      agent_browser_screenshot: async (args, timeout) => {
        // The model never chooses where the file lands: `path` and `screenshotDir` would write anywhere on this host.
        const type = args.format === "jpeg" ? "jpeg" : "png";
        mkdirSync(this.screenshotDir, { recursive: true, mode: 0o700 });
        const path = join(this.screenshotDir, `screenshot-${Date.now()}.${type}`);
        const page = await this.page();
        const selector = optionalString(args, "selector");
        const options = { path, type, timeout, ...(type === "jpeg" && numberArg(args, "quality") !== undefined ? { quality: numberArg(args, "quality") } : {}) } as const;
        if (selector) await (await this.locate(page, selector)).screenshot(options);
        else await page.screenshot({ ...options, fullPage: args.fullPage === true });
        return path;
      },
      // OMB's own two tools beside the core profile (browser-runtime.ts advertises them). The internal browser route already
      // limited `files` to the conversation's attachments and the bot's own folder.
      agent_browser_upload: async (args, timeout) => {
        const selector = stringArg(args, "selector");
        const files = Array.isArray(args.files) ? args.files.filter((file): file is string => typeof file === "string" && file !== "") : [];
        if (!files.length) throw new Error("files is required.");
        await (await this.locate(await this.page(), selector)).setInputFiles(files, { timeout });
        return json({ uploaded: files.length, selector });
      },
      agent_browser_hover: async (args, timeout) => {
        const selector = stringArg(args, "selector");
        await (await this.locate(await this.page(), selector)).hover({ timeout });
        return json({ hovered: selector });
      },
      agent_browser_get_text: async (args, timeout) => (await this.locate(await this.page(), stringArg(args, "selector"))).innerText({ timeout }),
      agent_browser_get_url: async () => (await this.page()).url(),
      agent_browser_get_title: async () => (await this.page()).title(),
      agent_browser_eval: async (args) => {
        const page = await this.page();
        const value = await page.evaluate(stringArg(args, "script")).catch((error: unknown) => {
          throw new Error(`Evaluation error: ${error instanceof Error ? error.message.replace(/^[\w.]+: /, "") : String(error)}`);
        });
        return value === undefined ? "undefined" : json(value);
      },
      agent_browser_close: async () => {
        // A headed Chrome quits with its last window, and the runtime owns Chrome: keep one blank tab.
        const fresh = this.adopt(await this.context.newPage());
        const others = this.liveTabs().filter((tab) => tab !== fresh);
        this.active = fresh;
        await Promise.all(others.map((tab) => tab.page.close().catch(() => {})));
        return json({ closed: true });
      },
      // A page restored from the back/forward cache fires no load events: wait for the commit, then settle.
      agent_browser_back: async (_, timeout) => {
        const page = await this.page();
        await page.goBack({ waitUntil: "commit", timeout });
        await settle(page);
        return page.url();
      },
      agent_browser_forward: async (_, timeout) => {
        const page = await this.page();
        await page.goForward({ waitUntil: "commit", timeout });
        await settle(page);
        return page.url();
      },
      agent_browser_reload: async (_, timeout) => {
        const page = await this.page();
        await page.reload({ waitUntil: "domcontentloaded", timeout });
        return page.url();
      },
      agent_browser_tab_new: async (args, timeout) => {
        const url = optionalString(args, "url");
        if (url) webUrl(url); // refuse before the new tab takes focus
        const tab = this.adopt(await this.context.newPage());
        tab.label = optionalString(args, "label");
        this.active = tab;
        if (url) await this.navigate(tab.page, url, timeout);
        return tab.page.url();
      },
      agent_browser_tab_list: async () => {
        await this.page();
        return json({ tabs: await this.tabList() });
      },
      agent_browser_tab_switch: async (args) => {
        const tab = this.findTab(stringArg(args, "tab"));
        this.active = tab;
        await tab.page.bringToFront().catch(() => {});
        return tab.page.title();
      },
      agent_browser_tab_close: async (args) => {
        const name = optionalString(args, "tab");
        if (!name) await this.page();
        const tab = name ? this.findTab(name) : this.active!;
        if (this.liveTabs().length === 1) this.active = this.adopt(await this.context.newPage()); // see agent_browser_close
        await tab.page.close();
        return json({ closed: true, label: tab.label ?? null, tabId: tab.id });
      },
    };
  }

  /** Run one tool call; never throws, never outlives its budget: `budgetMs` (the runtime's time left for it) or the call ceiling. */
  call(name: string, args: Record<string, unknown>, budgetMs = MAX_CALL_MS): Promise<ToolResult> {
    const run = this.queue.then(() => this.run(name, args, budgetMs));
    this.queue = run;
    return run;
  }

  /** The active tab's page, which the Browser panel shows and a person's input reaches. */
  livePage(): Promise<Page> {
    if (this.stopped) return Promise.reject(new Error("The browser engine has stopped."));
    return this.page();
  }

  async tabList(): Promise<TabInfo[]> {
    return Promise.all(this.liveTabs().map(async (tab) => ({
      active: tab === this.active,
      label: tab.label ?? null,
      tabId: tab.id,
      title: await bounded(tab.page.title(), TAB_TITLE_MS, "title").catch(() => ""),
      url: tab.page.url(),
    })));
  }

  /** Called whenever the active tab, the tab list or a tab's page may have changed; returns the unsubscribe. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Stop answering and detach from the context; its pages stay open. */
  async close(): Promise<void> {
    this.stopped = true;
    this.context.off("page", this.adopt);
    this.context.off("dialog", this.answerDialog);
    for (const tab of this.tabs) {
      tab.page.off("close", this.drop);
      tab.page.off("crash", this.drop);
      tab.page.off("framenavigated", this.navigated);
      tab.page.off("domcontentloaded", this.changed);
    }
    this.tabs = [];
    this.active = undefined;
    this.changed();
  }

  private readonly changed = (): void => {
    for (const listener of this.listeners) listener();
  };

  private readonly navigated = (frame: Frame): void => {
    if (!frame.parentFrame()) this.changed();
  };

  private async run(name: string, args: Args, budgetMs: number): Promise<ToolResult> {
    if (this.stopped) return { content: [{ type: "text", text: "The browser engine has stopped." }], isError: true };
    const tool = this.tools[name];
    if (!tool) return { content: [{ type: "text", text: `Unknown browser tool: ${name}` }], isError: true };
    const requested = numberArg(args, "waitTimeoutMs") ?? numberArg(args, "readTimeoutMs")
      ?? (name === "agent_browser_wait_ms" ? (numberArg(args, "ms") ?? 0) + CALL_TIMEOUT_MS : CALL_TIMEOUT_MS);
    const timeout = Math.max(1, Math.min(requested, Math.min(budgetMs, MAX_CALL_MS) - RACE_SLACK_MS));
    try {
      const text = await bounded(tool(args, timeout), timeout + RACE_SLACK_MS, name);
      return { content: [{ type: "text", text }], isError: false };
    } catch (error) {
      // A timed-out call is a failed call like any other: the queue moves on, so the session never needs a restart for it.
      if (error instanceof CallTimeout) this.log?.(`stealth-browser: ${name} timed out after ${timeout + RACE_SLACK_MS}ms`);
      return { content: [{ type: "text", text: errorText(error) }], isError: true };
    } finally {
      this.changed();
    }
  }

  private readonly adopt = (page: Page): Tab => {
    const known = this.tabs.find((tab) => tab.page === page);
    if (known) return known;
    const tab: Tab = { id: `t${this.nextTab++}`, page };
    this.tabs.push(tab);
    page.on("close", this.drop);
    page.on("crash", this.drop);
    page.on("framenavigated", this.navigated);
    page.on("domcontentloaded", this.changed);
    this.changed();
    return tab;
  };

  private readonly drop = (page: Page): void => {
    this.tabs = this.tabs.filter((tab) => tab.page !== page);
    if (this.active?.page === page) this.active = undefined;
    if (!page.isClosed()) void page.close().catch(() => {});
    this.changed();
  };

  private readonly answerDialog = (dialog: Dialog): void => {
    void dialog.accept(dialog.defaultValue()).catch(() => {}); // another listener may have answered it already
  };

  /** The active tab; when it is gone, the newest live tab, or a fresh blank one. */
  private async page(): Promise<Page> {
    if (this.active && !this.active.page.isClosed()) return this.active.page;
    this.active = this.liveTabs().findLast((tab) => !tab.page.isClosed())
      ?? await (this.opening ??= this.context.newPage().then(this.adopt).finally(() => { this.opening = undefined; }));
    return this.active.page;
  }

  /** The solver marks its shadow page only after the context announced it, so it is filtered here, not on adoption. */
  private liveTabs(): Tab[] {
    return this.tabs.filter((tab) => !isCloudflareShadowPage(tab.page));
  }

  private findTab(name: string): Tab {
    const tab = this.liveTabs().find((candidate) => candidate.id === name || candidate.label === name);
    if (!tab) throw new Error(`No tab matches ${name}. Use agent_browser_tab_list to see the open tabs.`);
    return tab;
  }

  private async navigate(page: Page, url: string, timeout: number): Promise<void> {
    const target = webUrl(url);
    await this.prepare?.(page);
    await page.goto(target, { waitUntil: "domcontentloaded", timeout });
    await settle(page);
  }

  /** `@e3`, `e3` (refs from this tab's latest snapshot) or a CSS selector. */
  private locator(page: Page, selector: string): Locator {
    const ref = /^@?((?:f\d+)?e\d+)$/.exec(selector);
    return page.locator(ref ? `aria-ref=${ref[1]}` : selector).first();
  }

  /** Pages keep rendering after `open` answers, so a missing element gets a short grace to attach. */
  private async locate(page: Page, selector: string): Promise<Locator> {
    const element = this.locator(page, selector);
    if (!await element.count()) await element.waitFor({ state: "attached", timeout: ATTACH_GRACE_MS }).catch(() => {});
    if (!await element.count()) throw new Error(`Element not found: ${selector}. Verify the selector, role, or name is correct and the element exists in the DOM.`);
    return element;
  }
}
