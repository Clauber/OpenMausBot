// LEGION's built-in stealth browser: the app wiring around the vendored
// runtime in server/stealth-browser/. When config turns it on
// (browserEngine.stealth.enabled), every bot browser session gets a
// persistent, fingerprinted Chrome launched inside this process instead of
// agent-browser spawning its own plain one. The bot's browser tools run
// in-process on the runtime's own patchright context (stealth-browser/engine.ts).
//
// The runtime is created once per process from the settings it first saw:
// changing the port base or headed flag takes effect on restart, which keeps
// live contexts and their recorded ports meaningful.
import { join } from "node:path";

import type { BrowserContext, Page } from "patchright";

import { DATA_DIR, browserStealthEnabled, browserStealthOptions, type AppConfig } from "./config.ts";
import { createStealthRuntime, type StealthRuntime } from "./stealth-browser/runtime.ts";

export { browserStealthEnabled, browserStealthOptions };

let runtime: StealthRuntime | null = null;

function runtimeFor(cfg: AppConfig): StealthRuntime {
  if (!runtime) {
    runtime = createStealthRuntime({
      stateDir: join(DATA_DIR, "stealth-browser", "state"),
      profilesDir: join(DATA_DIR, "stealth-browser", "profiles"),
      ...browserStealthOptions(cfg),
      log: (line) => console.log(line),
    });
  }
  return runtime;
}

export function stealthCdpTarget(session: string, cfg: AppConfig): Promise<string> {
  return runtimeFor(cfg).cdpTarget(session);
}

/** The session's patchright context, which its bot's browser tools drive in-process. */
export function stealthContext(session: string, cfg: AppConfig): Promise<BrowserContext> {
  return runtimeFor(cfg).context(session);
}

/** Resolves once the session's identity is installed on `page`; the engine awaits it before every navigation. */
export function stealthPrepare(session: string, page: Page, cfg: AppConfig): Promise<void> {
  return runtimeFor(cfg).prepare(session, page);
}

/** Where a stealth session's screenshots land. */
export function stealthScreenshotDir(session: string): string {
  return join(DATA_DIR, "stealth-browser", "screenshots", session);
}

/** Close a session's Chrome but keep its identity; the next target relaunches it. */
export function closeStealthSession(session: string, cfg: AppConfig): Promise<boolean> {
  return runtimeFor(cfg).closeSession(session);
}

/** Forget a session's stealth profile, fingerprint and port. Guest sessions
 * and deleted bots/profiles have no reason to keep an identity on disk. */
export function dropStealthSession(session: string, cfg: AppConfig): Promise<boolean> {
  return runtimeFor(cfg).dropSession(session);
}

export async function shutdownStealthBrowser(): Promise<void> {
  await runtime?.shutdown();
  runtime = null;
}
