// The stealth engine behind the same surface as BrowserClient
// (server/browser-runtime.ts): `ready`, `rpc(method, params)` and `stop()`,
// answering the MCP methods the runtime sends. The tool list is agent-browser
// 0.37.0's own `tools/list`, so the runtime's schema slimming, result shaping
// and click-by-description work unchanged.
import type { BrowserContext, Page } from "patchright";

import { TransportError } from "../browser-runtime.ts";
import TOOLS from "./agent-browser-tools.json" with { type: "json" };
import { StealthBrowserEngine } from "./engine.ts";

export class StealthBrowserClient {
  readonly ready: Promise<void>;
  private engine?: StealthBrowserEngine;
  private stopped = false;
  private stoppedPromise?: Promise<void>;
  private onClose?: () => void;

  constructor(context: BrowserContext | Promise<BrowserContext>, options: { screenshotDir: string; log?: (line: string) => void; prepare?: (page: Page) => Promise<void>; onClose?: () => void }) {
    this.onClose = options.onClose;
    this.ready = Promise.resolve(context).then((resolved) => {
      if (this.stopped) throw new TransportError("Browser connection closed.");
      this.engine = new StealthBrowserEngine(resolved, { screenshotDir: options.screenshotDir, log: options.log, prepare: options.prepare });
      // Chrome crashed, disconnected or was closed by the runtime: forget this client so the next call reconnects.
      resolved.once("close", () => { void this.stop(); });
    }).catch((error: unknown) => {
      void this.stop();
      throw error;
    });
  }

  /** `timeoutMs` bounds a tool call, which then answers as an ordinary failed call; nothing waits on it past that. */
  async rpc(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.stopped) throw new TransportError("Browser connection closed.");
    if (method === "initialize") {
      return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "openmausbot-stealth-browser", version: "1" } };
    }
    if (method === "tools/list") return { tools: TOOLS.tools };
    if (method !== "tools/call") throw new Error(`Method not found: ${method}`);
    const request = params as { name?: unknown; arguments?: unknown } | null;
    if (typeof request?.name !== "string") throw new Error("A tool call needs a tool name.");
    const args = request.arguments && typeof request.arguments === "object" ? request.arguments as Record<string, unknown> : {};
    return (await this.liveEngine()).call(request.name, args, timeoutMs);
  }

  /** The engine itself, so the Browser panel shows and acts on the same tabs as the bot. */
  async liveEngine(): Promise<StealthBrowserEngine> {
    await this.ready;
    if (this.stopped || !this.engine) throw new TransportError("Browser connection closed.");
    return this.engine;
  }

  /** Detach from the browser; its tabs stay open, as the stealth runtime owns Chrome. */
  stop(): Promise<void> {
    if (this.stoppedPromise) return this.stoppedPromise;
    this.stopped = true;
    this.onClose?.();
    this.stoppedPromise = this.engine?.close() ?? Promise.resolve();
    return this.stoppedPromise;
  }
}
