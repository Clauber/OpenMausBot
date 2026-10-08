// The stealth browser runtime: one patchright persistent context per browser
// session, launched with that session's own fingerprint and kept open here.
//
// The context must stay open in this process for the stealth to hold: the
// fingerprint is attached by this Playwright client, and the evasion script
// (evasions.ts) is re-evaluated on every navigation by this client's
// listeners — a Chrome detached from this process keeps only its launch
// flags. Callers hand the context's CDP port to an automation client
// (agent-browser); pages that client opens still get the evasions, because
// the context's page events fire here too.
//
// Each session keeps a stable CDP port and a stable fingerprint across
// restarts (state dir), so a browser session stays one identity for the
// sites that see it. There is deliberately no idle close: a context closed
// under a working bot takes its logins' page state with it, and the port is
// only reclaimed when the caller drops the session or the process shuts down.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import type { Fingerprint } from "fingerprint-generator";
import type { BrowserContext } from "patchright";

import { BROWSER_ARGS, loadFingerprintSuite, loadPatchright } from "./stealth.ts";
import { buildEvasionScript } from "./evasions.ts";

type FingerprintBundle = { fingerprint: Fingerprint; headers: Record<string, string> };

const SESSION_NAME = /^[A-Za-z0-9_.-]{1,96}$/;
const XVFB_SCREEN = "2560x1440x24";
const PORT_PROBE_TIMEOUT_MS = 250;
const DISPLAY_WAIT_MS = 10_000;

export interface StealthRuntimeOptions {
  /** Fingerprints, port assignments. Secrets-adjacent: keep 0700. */
  stateDir: string;
  /** Chrome profile directories, one per session. */
  profilesDir: string;
  /** First CDP port handed out; later sessions count up from here. */
  debugPortBase: number;
  /** Headed Chrome is meaningfully harder to fingerprint than headless;
   * displayless Linux hosts get an automatic Xvfb display unless this is
   * explicitly turned off. */
  headed?: boolean;
  /** A system Chrome to use when channel:"chrome" is not installed. */
  chromeExecutable?: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

export interface StealthRuntime {
  /** The loopback CDP endpoint a client attaches to for this session. */
  cdpTarget(session: string): Promise<string>;
  /** Close a session's context and forget its profile, fingerprint and port. */
  dropSession(session: string): Promise<boolean>;
  shutdown(): Promise<void>;
}

interface PersistentSession {
  context: BrowserContext;
  debugPort: number;
  lastAccess: number;
}

export function isValidStealthSession(session: string): boolean {
  return SESSION_NAME.test(session) && !session.includes("..");
}

function portBusy(port: number, timeoutMs = PORT_PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createServer();
    socket.once("error", () => resolve(true));
    socket.once("listening", () => socket.close(() => resolve(false)));
    try {
      socket.listen({ port, host: "127.0.0.1" });
    } catch {
      resolve(true);
    }
    // A listen that neither errors nor binds within the timeout is treated
    // as busy: refusing a port costs one retry, racing a CDP listener on it
    // costs a Chrome that starts without a working DevTools endpoint.
    const timer = setTimeout(() => {
      socket.close();
      resolve(true);
    }, timeoutMs);
    timer.unref?.();
  });
}

/** The context's browser-level CDP endpoint, from the debug port this
 * runtime launched the browser with. */
function browserCdpUrl(port: number): Promise<string | null> {
  return fetch(`http://127.0.0.1:${port}/json/version`)
    .then((response) => response.json() as Promise<{ webSocketDebuggerUrl?: string }>)
    .then((body) => body.webSocketDebuggerUrl ?? null)
    .catch(() => null);
}

/** Poll the context's CDP endpoint until it answers both /json/version and
 * /json/list, so the first client to discover it succeeds. */
async function waitForCdpEndpoint(port: number, session: string, log?: (line: string) => void): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const version = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (version.ok) {
        const list = await fetch(`http://127.0.0.1:${port}/json/list`);
        if (list.ok) return;
      }
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  log?.(`stealth-browser: session "${session}" CDP endpoint did not answer in time${lastError ? ` (${(lastError as Error).message})` : ""}`);
}

/** Register `script` to run before every document in this browser, for
 * targets created by any CDP client — the automation client attaches to this
 * browser itself and opens its pages behind our back, so context-level init
 * scripts never reach them. Discovers page targets on the browser's own
 * debug endpoint and adds the pre-document script to each. */
async function attachBrowserLevelInjection(context: BrowserContext, debugPort: number, script: string, session: string, log?: (line: string) => void): Promise<void> {
  if (!context.browser()) return;
  const wsUrl = await browserCdpUrl(debugPort);
  if (!wsUrl) {
    log?.(`stealth-browser: session "${session}" could not reach its CDP endpoint for browser-wide injection`);
    return;
  }
  const socket = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("the stealth browser's CDP endpoint refused a connection"));
  });
  let nextId = 1;
  const pending = new Map<number, (value: unknown) => void>();
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; method?: string; params?: { targetInfo?: { type?: string; targetId?: string } } };
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)?.(message.result);
      pending.delete(message.id);
      return;
    }
    if (message.method !== "Target.targetCreated") return;
    const info = message.params?.targetInfo;
    if (info?.type !== "page" || !info.targetId) return;
    void (async () => {
      const attached = await send("Target.attachToTarget", { targetId: info.targetId, flatten: true }) as { sessionId?: string } | undefined;
      if (!attached?.sessionId) return;
      // runImmediately patches a document the client already committed (the
      // automation client can navigate between target creation and our
      // attach); every later document gets the script before its own scripts.
      await send("Page.addScriptToEvaluateOnNewDocument", { source: script, runImmediately: true }, attached.sessionId).catch(() => {});
    })();
  };
  await send("Target.setDiscoverTargets", { discover: true });
  log?.(`stealth-browser: session "${session}" registers browser-wide identity injection`);
}

/** A display for headed Chrome on a host with none. Spawns one Xvfb per
 * process and returns the DISPLAY to launch the browser with; undefined when
 * the host already has a display or does not need one. */
let sharedDisplay: { value: string; child: ReturnType<typeof spawn> } | null = null;
async function ensureDisplay(env: NodeJS.ProcessEnv, log?: (line: string) => void): Promise<string | undefined> {
  if (env.DISPLAY || env.WAYLAND_DISPLAY || process.platform !== "linux") return undefined;
  if (sharedDisplay) return sharedDisplay.value;
  const child = spawn("Xvfb", ["-displayfd", "1", "-screen", "0", XVFB_SCREEN, "-nolisten", "tcp"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const number = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Xvfb did not report a display number in time")), DISPLAY_WAIT_MS);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      output += String(chunk);
      const line = output.split("\n")[0]?.trim();
      if (/^[0-9]+$/.test(line ?? "")) {
        clearTimeout(timer);
        resolve(line);
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      const nodeError = error as NodeJS.ErrnoException;
      reject(new Error(nodeError.code === "ENOENT"
        ? "the stealth browser needs a display on this Linux host: install Xvfb (e.g. `apt install xvfb`) or set browserEngine.stealth.headed to false to run headless"
        : `Xvfb could not start: ${nodeError.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`Xvfb exited before reporting a display (code ${code ?? "signal"})`));
    });
  });
  sharedDisplay = { value: `:${number}`, child };
  child.on("close", () => { if (sharedDisplay?.child === child) sharedDisplay = null; });
  log?.(`stealth-browser: Xvfb display ${sharedDisplay.value} for headed Chrome`);
  return sharedDisplay.value;
}

const debugPortsFile = (stateDir: string) => join(stateDir, "debug-ports.json");
const fingerprintFile = (stateDir: string, session: string) => join(stateDir, `${session}-fingerprint.json`);
export const stealthProfileDir = (profilesDir: string, session: string) => join(profilesDir, session);

function loadDebugPorts(stateDir: string): Record<string, number> {
  // A corrupt file must not reset the map, or a new session could take a
  // live context's port; the file is only ever written by us.
  try { return JSON.parse(readFileSync(debugPortsFile(stateDir), "utf-8")) as Record<string, number>; }
  catch { return {}; }
}

function writeDebugPorts(stateDir: string, ports: Record<string, number>): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const temporary = `${debugPortsFile(stateDir)}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(ports, null, 2), { mode: 0o600 });
  renameSync(temporary, debugPortsFile(stateDir));
}

/** A session's identity, generated once and then read from disk so every
 * launch of the same browser session is the same person to the sites it
 * visits. */
export async function loadOrCreateFingerprint(stateDir: string, session: string, log?: (line: string) => void): Promise<FingerprintBundle> {
  try {
    const data = JSON.parse(readFileSync(fingerprintFile(stateDir, session), "utf-8")) as FingerprintBundle;
    if (data.fingerprint && data.headers) return data;
  } catch {
    // first session, or an unreadable file gets a fresh identity
  }
  const { generator } = await loadFingerprintSuite();
  const generated = generator.getFingerprint();
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(fingerprintFile(stateDir, session), JSON.stringify(generated, null, 2), { mode: 0o600 });
  } catch (error) {
    log?.(`stealth-browser: could not persist the fingerprint for "${session}" (${(error as Error).message}); it regenerates on next launch`);
  }
  return generated;
}

/** Reserve a session's CDP port: its recorded port when still free, else the
 * first free port at or above the base. The reservation is recorded
 * immediately so two sessions starting side by side cannot be handed the
 * same port; a launch that then fails forgets its reservation (below), which
 * returns the port to the pool. Recorded ports keep a live context
 * attachable at the same loopback address across restarts. */
export async function reserveCdpPort(stateDir: string, debugPortBase: number, session: string, log?: (line: string) => void): Promise<number> {
  const ports = loadDebugPorts(stateDir);
  const recorded = ports[session];
  let port: number;
  if (Number.isInteger(recorded) && !(await portBusy(recorded))) {
    return recorded; // already recorded; nothing new to persist
  }
  const used = new Set(Object.values(ports));
  port = -1;
  for (let candidate = debugPortBase; candidate < 65536; candidate++) {
    if (!used.has(candidate) && !(await portBusy(candidate))) {
      port = candidate;
      break;
    }
  }
  if (port === -1) throw new Error(`no free CDP port at or above ${debugPortBase} for the stealth browser`);
  if (recorded !== undefined) log?.(`stealth-browser: session "${session}" moves from port ${recorded} to ${port}`);
  ports[session] = port;
  writeDebugPorts(stateDir, ports);
  return port;
}

/** Forget a session's port assignment, so a dropped session cannot reserve
 * its old port forever. */
export function forgetCdpPort(stateDir: string, session: string): boolean {
  const ports = loadDebugPorts(stateDir);
  if (!Number.isInteger(ports[session])) return false;
  delete ports[session];
  try { writeDebugPorts(stateDir, ports); } catch { /* a reused port on next launch is harmless */ }
  return true;
}

export function createStealthRuntime(options: StealthRuntimeOptions): StealthRuntime {
  const env = options.env ?? process.env;
  const headed = options.headed !== false;
  const log = options.log;
  const sessions = new Map<string, PersistentSession>();
  const launching = new Map<string, Promise<PersistentSession>>();

  async function launchPersistentContext(session: string): Promise<PersistentSession> {
    const { chromium } = await loadPatchright();
    const directory = stealthProfileDir(options.profilesDir, session);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const { fingerprint, headers } = await loadOrCreateFingerprint(options.stateDir, session, log);
    const debugPort = await reserveCdpPort(options.stateDir, options.debugPortBase, session, log);
    const launchOpts: Record<string, unknown> = {
      headless: !headed,
      args: [...BROWSER_ARGS, `--remote-debugging-port=${debugPort}`],
      userAgent: (fingerprint.navigator as { userAgent: string }).userAgent,
      viewport: {
        width: (fingerprint.screen as { width: number }).width,
        height: (fingerprint.screen as { height: number }).height,
      },
      locale: (fingerprint.navigator as { language: string }).language,
      timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    if (headed) {
      const display = await ensureDisplay(env, log);
      if (display) launchOpts.env = { ...env, DISPLAY: display };
    }

    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(directory, { ...launchOpts, channel: "chrome" });
    } catch (error) {
      const message = (error as Error).message ?? "";
      forgetCdpPort(options.stateDir, session);
      if (await portBusy(debugPort)) {
        throw new Error(`CDP port ${debugPort} was taken while the stealth browser for "${session}" was starting; try again`);
      }
      if (options.chromeExecutable) {
        try {
          context = await chromium.launchPersistentContext(directory, { ...launchOpts, executablePath: options.chromeExecutable });
          log?.(`stealth-browser: session "${session}" launched with ${options.chromeExecutable} (no system Google Chrome)`);
        } catch (fallbackError) {
          throw new Error(`the stealth browser could not launch Chrome: ${(fallbackError as Error).message}`);
        }
      } else if (message.includes("is not found") || message.includes("Executable doesn't exist")) {
        throw new Error("the stealth browser found no Google Chrome to launch: install Google Chrome, or run `patchright install chromium` for the fallback");
      } else {
        throw error;
      }
    }

    await (await loadFingerprintSuite()).injector.attachFingerprintToPlaywright(context as never, { fingerprint, headers });
    // Pages opened by the attached automation client are created by a
    // different CDP client than ours, so context-level init scripts never
    // reach them. Everything the page must see before its first script runs
    // is registered browser-wide over CDP instead: the fingerprint overrides
    // and the evasions in one pre-document script, on every new target.
    const script = `${(await loadFingerprintSuite()).injector.getInjectableScript({ fingerprint, headers })}\n;${buildEvasionScript(fingerprint, session)}`;
    await attachBrowserLevelInjection(context, debugPort, script, session, log);
    // The automation client decides CDP-attach versus launching its own
    // browser from its first discovery of this endpoint, and never retries,
    // so the endpoint must verifiably serve before its URL is handed out.
    await waitForCdpEndpoint(debugPort, session, log);

    log?.(`stealth-browser: context for "${session}" (Chrome, CDP port ${debugPort}, ${headed ? "headed" : "headless"})`);
    return { context, debugPort, lastAccess: Date.now() };
  }

  return {
    async cdpTarget(session: string): Promise<string> {
      if (!isValidStealthSession(session)) throw new Error(`Invalid stealth browser session name: ${session}`);
      const existing = sessions.get(session);
      if (existing) {
        existing.lastAccess = Date.now();
        return `http://127.0.0.1:${existing.debugPort}`;
      }
      let pending = launching.get(session);
      if (!pending) {
        pending = launchPersistentContext(session).then((launched) => {
          sessions.set(session, launched);
          return launched;
        }).finally(() => launching.delete(session));
        launching.set(session, pending);
      }
      const launched = await pending;
      return `http://127.0.0.1:${launched.debugPort}`;
    },

    async dropSession(session: string): Promise<boolean> {
      if (!isValidStealthSession(session)) return false;
      const launched = sessions.get(session);
      sessions.delete(session);
      if (launched) await launched.context.close().catch(() => {});
      let touched = Boolean(launched);
      if (forgetCdpPort(options.stateDir, session)) touched = true;
      try { rmSync(stealthProfileDir(options.profilesDir, session), { recursive: true, force: true }); touched = true; } catch { /* already gone */ }
      try { rmSync(fingerprintFile(options.stateDir, session), { force: true }); } catch { /* already gone */ }
      return touched;
    },

    async shutdown(): Promise<void> {
      const all = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled(all.map((launched) => launched.context.close()));
      if (sharedDisplay) {
        sharedDisplay.child.kill("SIGTERM");
        sharedDisplay = null;
      }
    },
  };
}
