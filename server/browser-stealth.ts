// LEGION's built-in stealth browser: the app wiring around the vendored
// runtime in server/stealth-browser/. When config turns it on
// (browserEngine.stealth.enabled), every bot browser session gets a
// persistent, fingerprinted Chrome launched inside this process instead of
// agent-browser spawning its own plain one, and the runtime hands back the
// loopback CDP port agent-browser attaches to.
//
// The runtime is created once per process from the settings it first saw:
// changing the port base or headed flag takes effect on restart, which keeps
// live contexts and their recorded ports meaningful.
import { join } from "node:path";

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

/** Forget a session's stealth profile, fingerprint and port. Guest sessions
 * and deleted bots/profiles have no reason to keep an identity on disk. */
export function dropStealthSession(session: string, cfg: AppConfig): Promise<boolean> {
  return runtimeFor(cfg).dropSession(session);
}

export async function shutdownStealthBrowser(): Promise<void> {
  await runtime?.shutdown();
  runtime = null;
}
