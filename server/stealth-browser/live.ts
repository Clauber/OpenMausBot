// The Browser panel's view of a stealth session: a CDP screencast of the
// engine's active tab, served behind the same socket surface browser-live.ts
// reads from agent-browser's stream (open/message/close events, `ack` sends)
// and emitting the same frame, status, tabs and url messages. A person's input
// and panel commands reach that same tab, so the bot and the person always see
// and act on one set of tabs.
import type { CDPSession, Page } from "patchright";

import { type StealthBrowserEngine, type ToolResult } from "./engine.ts";

/** agent-browser's own stream rate (`maxFps=15`). */
const FRAME_MS = 1000 / 15;
const OPEN = 1, CLOSED = 3;

type Message = Record<string, unknown>;
interface ScreencastFrame { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }
interface Sent { seq: number; cdp: CDPSession; sessionId: number }
/** A person's input as browser-live.ts relays it: CDP's own Input event fields under an `action`. */
export type LiveInput =
  | { action: "input_mouse"; type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel"; x: number; y: number; button?: "none" | "left" | "middle" | "right" | "back" | "forward"; clickCount?: number; modifiers?: number; deltaX?: number; deltaY?: number }
  | { action: "keyboard"; text: string }
  | { action: "press"; key: string }
  | { action: "input_keyboard"; type: "keyDown" | "keyUp" | "rawKeyDown" | "char"; key?: string; code?: string; text?: string; modifiers?: number; windowsVirtualKeyCode?: number };

/** The panel's tab and navigation verbs (parseBrowserLiveAction's args) as engine tools. */
function panelTool(args: readonly string[]): [string, Record<string, unknown>] {
  const [verb, sub, target] = args;
  if (verb === "open") return ["agent_browser_open", { url: sub }];
  if (verb === "back" || verb === "forward" || verb === "reload") return [`agent_browser_${verb}`, {}];
  if (verb === "tab" && sub === "new") return ["agent_browser_tab_new", target ? { url: target } : {}];
  if (verb === "tab" && sub === "close") return ["agent_browser_tab_close", { tab: target }];
  if (verb === "tab" && sub) return ["agent_browser_tab_switch", { tab: sub }];
  throw new Error(`Unknown browser command: ${verb}`);
}

export class StealthLiveStream extends EventTarget {
  readyState = 0;
  readonly bufferedAmount = 0;
  private readonly engine: StealthBrowserEngine;
  private readonly unsubscribe: () => void;
  private page?: Page;
  private cdp?: CDPSession;
  /** The screencast being started on `page`; input waits for it, so it reaches the tab the view is switching to. */
  private attaching?: Promise<void>;
  private seq = 0;
  /** The frame the view has not acknowledged yet; Chrome waits on its ack. */
  private sent?: Sent;
  /** The newest frame Chrome sent while the view was still on `sent`. */
  private held?: { cdp: CDPSession; frame: ScreencastFrame };
  private sentAt = 0;
  private pacing?: NodeJS.Timeout;
  private dirty = true;
  private syncing = false;
  private last: { tabs?: string; url?: string; size?: string } = {};

  constructor(engine: StealthBrowserEngine) {
    super();
    this.engine = engine;
    this.unsubscribe = engine.onChange(() => { this.dirty = true; void this.sync(); });
    void this.sync();
  }

  /** The view acknowledged frame `seq`: let Chrome send the next, no faster than FRAME_MS. */
  send(value: string): void {
    const message = JSON.parse(value) as Message;
    if (message.type !== "ack" || message.seq !== this.sent?.seq || this.pacing) return;
    this.pacing = setTimeout(() => {
      this.pacing = undefined;
      const done = this.sent;
      this.sent = undefined;
      if (done) void done.cdp.send("Page.screencastFrameAck", { sessionId: done.sessionId }).catch(() => {});
      const held = this.held;
      this.held = undefined;
      if (held) this.frame(held.cdp, held.frame);
    }, Math.max(0, this.sentAt + FRAME_MS - Date.now()));
    this.pacing.unref();
  }

  close(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.unsubscribe();
    this.detach();
    this.dispatchEvent(new Event("close"));
  }

  /** A person's input, in the command shapes browser-live.ts relays; resolves once Chrome handled it. */
  async input(command: LiveInput): Promise<void> {
    await this.attaching?.catch(() => {});
    const { cdp, page } = this;
    if (!cdp || !page) throw new Error("The browser stream is not connected.");
    if (command.action === "input_mouse") { const { action: _, ...event } = command; await cdp.send("Input.dispatchMouseEvent", event); }
    else if (command.action === "keyboard") await cdp.send("Input.insertText", { text: command.text });
    else if (command.action === "press") await page.keyboard.press(command.key);
    else if (command.action === "input_keyboard") { const { action: _, ...event } = command; await cdp.send("Input.dispatchKeyEvent", event); }
    else throw new Error("Unknown browser input.");
  }

  /** A panel command on the engine, queued with the bot's own calls. */
  command(args: readonly string[]): Promise<ToolResult> {
    const [name, toolArgs] = panelTool(args);
    return this.engine.call(name, toolArgs);
  }

  private emit(message: Message): void {
    if (this.readyState === OPEN) this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }

  /** Follow the engine: stream its active tab and report the tabs and URL whenever they change. */
  private async sync(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      while (this.dirty && this.readyState !== CLOSED) {
        this.dirty = false;
        const page = await this.engine.livePage();
        if (this.readyState === 0) {
          this.readyState = OPEN;
          this.dispatchEvent(new Event("open"));
          const size = page.viewportSize();
          this.emit({ type: "status", connected: true, screencasting: true, viewportWidth: size?.width, viewportHeight: size?.height });
        }
        if (page !== this.page) {
          try { await (this.attaching = this.attach(page)); } catch (error) {
            // A tab that closed meanwhile is dropped by the engine, which announces the next active one.
            if (!page.isClosed()) throw error;
            this.dirty = true;
            continue;
          }
        }
        const tabs = JSON.stringify(await this.engine.tabList());
        if (tabs !== this.last.tabs) { this.last.tabs = tabs; this.emit({ type: "tabs", tabs: JSON.parse(tabs) }); }
        if (page.url() !== this.last.url) { this.last.url = page.url(); this.emit({ type: "url", url: page.url() }); }
      }
    } catch {
      if (this.readyState !== CLOSED) { this.dispatchEvent(new Event("error")); this.close(); }
    } finally {
      this.syncing = false;
    }
  }

  private async attach(page: Page): Promise<void> {
    this.detach();
    this.page = page;
    const cdp = await page.context().newCDPSession(page);
    if (this.page !== page || this.readyState === CLOSED) { void cdp.detach().catch(() => {}); return; }
    this.cdp = cdp;
    cdp.on("Page.screencastFrame", (frame) => this.frame(cdp, frame));
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 80 });
  }

  private detach(): void {
    clearTimeout(this.pacing);
    this.pacing = undefined;
    this.sent = undefined;
    this.held = undefined;
    const cdp = this.cdp;
    this.cdp = undefined;
    this.page = undefined;
    void cdp?.detach().catch(() => {}); // a closed tab already took its session with it
  }

  private frame(cdp: CDPSession, frame: ScreencastFrame): void {
    if (cdp !== this.cdp) return;
    if (this.sent) {
      // Chrome keeps at most two frames in flight; a replaced one is acknowledged so it cannot stall the next.
      if (this.held) void cdp.send("Page.screencastFrameAck", { sessionId: this.held.frame.sessionId }).catch(() => {});
      this.held = { cdp, frame };
      return;
    }
    const { metadata } = frame;
    const deviceWidth = Math.round(metadata.deviceWidth), deviceHeight = Math.round(metadata.deviceHeight);
    const size = `${deviceWidth}x${deviceHeight}`;
    if (this.last.size && size !== this.last.size) this.emit({ type: "status", connected: true, screencasting: true, viewportWidth: deviceWidth, viewportHeight: deviceHeight });
    this.last.size = size;
    this.sent = { seq: ++this.seq, cdp, sessionId: frame.sessionId };
    this.sentAt = Date.now();
    this.emit({ type: "frame", seq: this.sent.seq, data: frame.data, metadata: { ...metadata, deviceWidth, deviceHeight } });
  }
}
