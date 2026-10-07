import type { Browser, BrowserContext, BrowserServer } from "patchright";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";
import type { RouteMode, PersistentSession, TabEntry } from "./types";
import {
  STATE_DIR,
  PROFILES_DIR,
  DEFAULT_PROXY,
  RESIDENTIAL_PROXY,
  PERSISTENT_IDLE_MS,
  DEBUG_PORT_BASE,
  VIEWPORT,
  HOST,
} from "./types";
import {
  chromium,
  fingerprintGenerator,
  fingerprintInjector,
  BROWSER_ARGS,
} from "./stealth";
import { buildEvasionScript, attachEvasions } from "./evasions";

// --- Shared state ---
export const persistentSessions = new Map<string, PersistentSession>();
export const tabs = new Map<string, TabEntry>();
export const agentContexts = new Map<
  string,
  { context: BrowserContext; tabCount: number; route: RouteMode }
>();

export let browser: Browser | null = null;
export let browserServer: BrowserServer | null = null;
export const proxyBrowsers = new Map<string, Browser>();
export const proxyBrowserServers = new Map<string, BrowserServer>();

export function setBrowser(b: Browser | null) {
  browser = b;
}
export function setBrowserServer(s: BrowserServer | null) {
  browserServer = s;
}

// --- Profile / debug port helpers ---
export function agentProfileDir(agent: string): string {
  return path.join(PROFILES_DIR, agent);
}

// A profile keeps its CDP port across idle close and service restarts, so a
// client that attached by port (OpenMausBot's agent-browser) reconnects to the
// same address instead of a stale one.
const debugPortsPath = () => path.join(STATE_DIR, "debug-ports.json");
function loadDebugPorts(): Record<string, number> {
  // Missing means no profile has a port yet. A corrupt file must not reset
  // the map, or a new profile would take a running profile's port.
  if (!existsSync(debugPortsPath())) return {};
  return JSON.parse(readFileSync(debugPortsPath(), "utf-8"));
}
export function allocDebugPort(key: string): number {
  const ports = loadDebugPorts();
  if (Number.isInteger(ports[key])) return ports[key];
  const used = new Set(Object.values(ports));
  let port = DEBUG_PORT_BASE;
  while (used.has(port)) port++;
  ports[key] = port;
  mkdirSync(STATE_DIR, { recursive: true });
  const temporary = `${debugPortsPath()}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(ports, null, 2));
  renameSync(temporary, debugPortsPath());
  return port;
}

const AGENT_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,95}$/;
export function isValidAgentName(agent: string): boolean {
  return AGENT_NAME.test(agent) && !agent.includes("..");
}

// --- Persistent context management ---
// Two callers opening one profile at once (a bot's turn and its Browser panel)
// share one launch; a second Chrome on the same profile and port would fail.
const launching = new Map<string, Promise<BrowserContext>>();

export async function getOrCreatePersistentContext(
  agent: string,
  route: RouteMode = "direct",
): Promise<BrowserContext> {
  if (!isValidAgentName(agent)) throw new Error(`Invalid agent name: ${agent}`);
  const key = `${agent}:${route}`;
  const existing = persistentSessions.get(key);
  if (existing && existing.context) {
    existing.lastAccess = Date.now();
    return existing.context;
  }
  const pending = launching.get(key);
  if (pending) return pending;
  const launch = launchPersistentContext(agent, route, key);
  launching.set(key, launch);
  try {
    return await launch;
  } finally {
    launching.delete(key);
  }
}

async function launchPersistentContext(
  agent: string,
  route: RouteMode,
  key: string,
): Promise<BrowserContext> {

  const profileDir = agentProfileDir(agent);
  mkdirSync(profileDir, { recursive: true });

  const { fingerprint, headers } = loadOrCreateFingerprint(agent);
  const debugPort = allocDebugPort(key);
  const launchOpts: any = {
    headless: process.env.HEADLESS !== "false",
    args: [...BROWSER_ARGS, `--remote-debugging-port=${debugPort}`],
    userAgent: fingerprint.navigator.userAgent,
    viewport: VIEWPORT ?? {
      width: fingerprint.screen.width,
      height: fingerprint.screen.height,
    },
    locale: fingerprint.navigator.language,
    timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };

  let proxyServer: string | undefined;
  if (route === "vpn" && DEFAULT_PROXY) proxyServer = DEFAULT_PROXY;
  else if (route === "residential" && RESIDENTIAL_PROXY)
    proxyServer = RESIDENTIAL_PROXY;
  if (proxyServer) launchOpts.proxy = { server: proxyServer };

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      ...launchOpts,
      channel: "chrome",
    });
    console.log(
      `[stealth-browser] Persistent context for "${agent}" (Chrome, route: ${route})`,
    );
  } catch (err: any) {
    if (err?.message?.includes("is not found")) {
      context = await chromium.launchPersistentContext(profileDir, launchOpts);
      console.log(
        `[stealth-browser] Persistent context for "${agent}" (Chromium, route: ${route})`,
      );
    } else throw err;
  }

  await fingerprintInjector.attachFingerprintToPlaywright(context as any, {
    fingerprint,
    headers,
  });

  // Advanced evasions: WebGL spoofing, font spoofing, deterministic canvas/audio noise
  // Use route-based HTML injection on each page BEFORE navigation.
  const evasionScript = buildEvasionScript(fingerprint, agent);
  
  // Attach to any existing pages in the persistent context
  for (const existingPage of context.pages()) {
    await attachEvasions(existingPage, evasionScript);
  }
  
  // Attach to future pages created in this context
  context.on('page', async (page) => {
    await attachEvasions(page, evasionScript);
  });

  persistentSessions.set(key, {
    context,
    lastAccess: Date.now(),
    route,
    tabCount: 0,
    debugPort,
  });
  console.log(
    `[stealth-browser] Created persistent profile for "${agent}" at ${profileDir} (CDP port: ${debugPort})`,
  );
  return context;
}

// Cleanup idle persistent sessions
setInterval(async () => {
  const now = Date.now();
  for (const [key, session] of persistentSessions) {
    if (
      session.tabCount <= 0 &&
      now - session.lastAccess > PERSISTENT_IDLE_MS
    ) {
      console.log(`[stealth-browser] Closing idle persistent session: ${key}`);
      await session.context.close().catch(() => {});
      persistentSessions.delete(key);
    }
  }
}, 30000);

// --- State path helpers ---
export function agentStatePath(agent: string, route?: string): string {
  if (route && route !== "direct") {
    return path.join(STATE_DIR, `${agent}-${route}.json`);
  }
  return path.join(STATE_DIR, `${agent}.json`);
}

export function allAgentStatePaths(agent: string): string[] {
  const paths = [agentStatePath(agent)];
  for (const r of ["vpn", "residential"]) {
    const p = agentStatePath(agent, r);
    if (existsSync(p)) paths.push(p);
  }
  return paths;
}

export function mergeStorageStates(
  primary: string,
  fallback: string,
): object | undefined {
  try {
    const a = existsSync(primary)
      ? JSON.parse(readFileSync(primary, "utf-8"))
      : null;
    const b = existsSync(fallback)
      ? JSON.parse(readFileSync(fallback, "utf-8"))
      : null;
    if (a && a.cookies?.length > 0) return a;
    if (b && b.cookies?.length > 0) return b;
    return a || b || undefined;
  } catch {
    return undefined;
  }
}

// --- Fingerprint persistence ---
export function agentFingerprintPath(agent: string): string {
  return path.join(STATE_DIR, `${agent}-fingerprint.json`);
}

export function loadOrCreateFingerprint(agent?: string): {
  fingerprint: any;
  headers: Record<string, string>;
} {
  if (agent) {
    const fpPath = agentFingerprintPath(agent);
    try {
      if (existsSync(fpPath)) {
        const data = JSON.parse(readFileSync(fpPath, "utf-8"));
        if (data.fingerprint && data.headers) {
          console.log(
            `[stealth-browser] Loaded persisted fingerprint for agent "${agent}"`,
          );
          return data;
        }
      }
    } catch (err) {
      console.warn(
        `[stealth-browser] Failed to load fingerprint for "${agent}", generating fresh:`,
        err,
      );
    }
    const fp = fingerprintGenerator.getFingerprint();
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(fpPath, JSON.stringify(fp, null, 2));
      console.log(
        `[stealth-browser] Persisted new fingerprint for agent "${agent}"`,
      );
    } catch (err) {
      console.warn(
        `[stealth-browser] Failed to persist fingerprint for "${agent}":`,
        err,
      );
    }
    return fp;
  }
  return fingerprintGenerator.getFingerprint();
}

// --- Browser launch ---
export const CDP_PORT = parseInt(process.env.CDP_PORT || "9378", 10);
export const CDP_WS_PATH = process.env.CDP_WS_PATH || "/browser";

export async function launchBrowser(
  proxyServer?: string,
): Promise<{ browser: Browser; server: BrowserServer }> {
  const launchOpts: any = {
    args: BROWSER_ARGS,
    headless: process.env.HEADLESS !== "false",
    // The browser server takes unauthenticated control too: same interface as the API.
    ...(HOST ? { host: HOST } : {}),
  };
  if (proxyServer) launchOpts.proxy = { server: proxyServer };

  // Pin CDP port and wsPath so OC's built-in browser tool can connect
  // Only pin for the default (direct) browser; proxy browsers use random ports
  const serverOpts = proxyServer
    ? launchOpts
    : { ...launchOpts, port: CDP_PORT, wsPath: CDP_WS_PATH };

  let server: BrowserServer;
  try {
    server = await chromium.launchServer({ ...serverOpts, channel: "chrome" });
    console.log(
      `[stealth-browser] Using real Google Chrome${proxyServer ? ` (proxy: ${proxyServer})` : ""}`,
    );
  } catch (err: any) {
    if (err?.message?.includes("is not found")) {
      console.warn(
        "[stealth-browser] Chrome not found, falling back to Chromium",
      );
      server = await chromium.launchServer(serverOpts);
      console.log(
        `[stealth-browser] Using Playwright Chromium${proxyServer ? ` (proxy: ${proxyServer})` : ""}`,
      );
    } else throw err;
  }

  const wsUrl = server.wsEndpoint();
  console.log(`[stealth-browser] CDP WebSocket: ${wsUrl}`);
  const b = await chromium.connect(wsUrl);
  return { browser: b, server };
}

export async function getBrowserForRoute(route: RouteMode): Promise<Browser> {
  let proxyServer: string | undefined;
  if (route === "vpn" && DEFAULT_PROXY) proxyServer = DEFAULT_PROXY;
  else if (route === "residential" && RESIDENTIAL_PROXY)
    proxyServer = RESIDENTIAL_PROXY;

  if (!proxyServer) {
    if (!browser) {
      const result = await launchBrowser();
      browser = result.browser;
      browserServer = result.server;
    }
    return browser;
  }

  let proxyBrowser = proxyBrowsers.get(proxyServer);
  if (proxyBrowser && proxyBrowser.isConnected()) return proxyBrowser;

  try {
    const result = await launchBrowser(proxyServer);
    proxyBrowsers.set(proxyServer, result.browser);
    proxyBrowserServers.set(proxyServer, result.server);
    return result.browser;
  } catch (err: any) {
    // Proxy unreachable — fall back to direct routing
    console.warn(
      `[stealth-browser] ${route} proxy launch failed (${err?.message}), falling back to direct`,
    );
    if (!browser) {
      const result = await launchBrowser();
      browser = result.browser;
      browserServer = result.server;
    }
    return browser;
  }
}
