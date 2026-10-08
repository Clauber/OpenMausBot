import { v4 as uuidv4 } from "uuid";
import { existsSync, mkdirSync } from "fs";
import type { RouteMode, TabEntry } from "./types";
import { STATE_DIR, TAB_TIMEOUT_MS } from "./types";
import { fingerprintInjector } from "./stealth";
import { buildEvasionScript, attachEvasions } from "./evasions";
import { attachBuffers } from "./buffers";
import { randomDelay, humanMove } from "./human-helpers";
import {
  tabs,
  agentContexts,
  persistentSessions,
  getBrowserForRoute,
  loadOrCreateFingerprint,
  agentStatePath,
} from "./browser";

// --- Tab creation ---
export async function createTab(
  url: string,
  agent?: string,
  route: RouteMode = "direct",
): Promise<string> {
  const routeBrowser = await getBrowserForRoute(route);
  const id = uuidv4();

  if (agent && agentContexts.has(agent)) {
    const cached = agentContexts.get(agent)!;
    if (cached.route === route) {
      const page = await cached.context.newPage();
      // Attach evasions BEFORE navigation
      const { fingerprint: cachedFp } = loadOrCreateFingerprint(agent);
      const cachedEvasionScript = buildEvasionScript(cachedFp, agent);
      await attachEvasions(page, cachedEvasionScript);
      await page.route(
        "**/{fingerprint,fp,collect,track,beacon,pixel}.{js,gif,png}",
        (r) => r.abort(),
      );
      const nowCached = Date.now();
      const cachedEntry: TabEntry = {
        context: cached.context,
        page,
        lastAccess: nowCached,
        lastUsedAt: nowCached,
        createdAt: nowCached,
        persistent: true,
        agent,
        route,
        refs: {},
        consoleBuffer: [],
        networkBuffer: [],
      };
      tabs.set(id, cachedEntry);
      await attachBuffers(cachedEntry);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      cached.tabCount++;
      console.log(
        `[stealth-browser] Tab ${id} created for agent "${agent}" (reused context, ${cached.tabCount} tabs, route: ${route})`,
      );
      return id;
    }
  }

  const { fingerprint, headers } = loadOrCreateFingerprint(agent);

  const BROWSER_MANAGED_HEADERS = new Set([
    "sec-fetch-site",
    "sec-fetch-mode",
    "sec-fetch-user",
    "sec-fetch-dest",
    "upgrade-insecure-requests",
  ]);
  const safeHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!BROWSER_MANAGED_HEADERS.has(key.toLowerCase())) {
      safeHeaders[key] = value;
    }
  }

  let storageState: string | undefined;
  if (agent) {
    const routeSpecific = agentStatePath(agent, route);
    const directPath = agentStatePath(agent);
    if (existsSync(routeSpecific)) storageState = routeSpecific;
    else if (existsSync(directPath)) storageState = directPath;
  }

  const context = await routeBrowser.newContext({
    userAgent: fingerprint.navigator.userAgent,
    viewport: {
      width: fingerprint.screen.width,
      height: fingerprint.screen.height,
    },
    locale: fingerprint.navigator.language,
    timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
    extraHTTPHeaders: {
      ...safeHeaders,
      "Accept-Language": fingerprint.navigator.language + ",en;q=0.9",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Encoding": "gzip, deflate, br, zstd",
    },
    storageState,
  });

  await fingerprintInjector.attachFingerprintToPlaywright(context as any, {
    fingerprint,
    headers,
  });

  // Advanced evasions: WebGL spoofing, font spoofing, deterministic canvas/audio noise
  // Injected via route interception because Patchright blocks context.addInitScript
  const evasionScript = buildEvasionScript(fingerprint, agent);

  const page = await context.newPage();
  await attachEvasions(page, evasionScript);
  await page.route(
    "**/{fingerprint,fp,collect,track,beacon,pixel}.{js,gif,png}",
    (r) => r.abort(),
  );

  // Register tab + attach buffer listeners BEFORE navigation so the first page
  // load's console/network events land in the buffer.
  const nowFresh = Date.now();
  const freshEntry: TabEntry = {
    context,
    page,
    lastAccess: nowFresh,
    lastUsedAt: nowFresh,
    createdAt: nowFresh,
    persistent: false,
    agent,
    route,
    refs: {},
    consoleBuffer: [],
    networkBuffer: [],
  };
  tabs.set(id, freshEntry);
  await attachBuffers(freshEntry);

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

  const vp = page.viewportSize() ?? { width: 1280, height: 720 };
  await randomDelay(300, 800);
  await humanMove(
    page,
    vp.width * 0.3 + Math.random() * vp.width * 0.4,
    vp.height * 0.3 + Math.random() * vp.height * 0.3,
  );
  await randomDelay(200, 500);
  await page.mouse.wheel(0, 50 + Math.random() * 100);

  if (agent) {
    agentContexts.set(agent, { context, tabCount: 1, route });
    console.log(
      `[stealth-browser] Tab ${id} created for agent "${agent}" (state: ${storageState ? "loaded" : "fresh"}, route: ${route})`,
    );
  }
  return id;
}

// --- Tab lifecycle ---
export function touchTab(id: string): TabEntry | undefined {
  const tab = tabs.get(id);
  if (tab) {
    const now = Date.now();
    tab.lastAccess = now;
    tab.lastUsedAt = now;
  }
  return tab;
}

export async function saveAgentState(tab: TabEntry): Promise<void> {
  if (!tab.agent) return;
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const statePath = agentStatePath(tab.agent, tab.route);
    await tab.context.storageState({ path: statePath });
    if (tab.route && tab.route !== "direct") {
      const defaultPath = agentStatePath(tab.agent);
      await tab.context.storageState({ path: defaultPath });
    }
    console.log(
      `[stealth-browser] Saved state for agent "${tab.agent}" (route: ${tab.route || "direct"})`,
    );
  } catch (err) {
    console.error(
      `[stealth-browser] Failed to save state for agent "${tab.agent}":`,
      err,
    );
  }
}

export async function closeTab(id: string): Promise<void> {
  const tab = tabs.get(id);
  if (!tab) return;
  if (tab.activeRecordingId) {
    const { stopRecording } = await import("./recording.js");
    await stopRecording(tab.activeRecordingId).catch(() => {});
    tab.activeRecordingId = undefined;
  }
  tabs.delete(id);
  try {
    if (tab.agent) {
      const persistKey = `${tab.agent}:${tab.route || "direct"}`;
      const persistent = persistentSessions.get(persistKey);
      if (persistent) {
        persistent.tabCount--;
        persistent.lastAccess = Date.now();
        await tab.page.close().catch(() => {});
        console.log(
          `[stealth-browser] Closed persistent tab ${id} for "${tab.agent}" (${persistent.tabCount} tabs remaining)`,
        );
        return;
      }
    }
    await saveAgentState(tab);
    if (tab.agent && agentContexts.has(tab.agent)) {
      const cached = agentContexts.get(tab.agent)!;
      cached.tabCount--;
      if (cached.tabCount <= 0) {
        agentContexts.delete(tab.agent);
        await tab.context.close();
        console.log(
          `[stealth-browser] Closed shared context for agent "${tab.agent}" (last tab)`,
        );
      } else {
        await tab.page.close();
        console.log(
          `[stealth-browser] Closed tab ${id} for agent "${tab.agent}" (${cached.tabCount} tabs remaining)`,
        );
      }
    } else {
      await tab.context.close();
    }
  } catch {
    /* ignore close errors */
  }
}

export async function closeAllTabs(): Promise<void> {
  const ids = [...tabs.keys()];
  await Promise.allSettled(ids.map(closeTab));
  agentContexts.clear();
}

// Auto-cleanup idle tabs
export const cleanupInterval = setInterval(async () => {
  const now = Date.now();
  for (const [id, tab] of tabs.entries()) {
    if (now - tab.lastAccess > TAB_TIMEOUT_MS) {
      console.log(`[stealth-browser] Closing idle tab ${id}`);
      await closeTab(id);
    }
  }
}, 15000);

// --- Ref resolution ---
export function resolveRef(tab: TabEntry, ref: string): any {
  const info = tab.refs[ref];
  if (!info)
    throw new Error(
      `Unknown ref "${ref}". The page may have changed — use "read" to get a fresh snapshot.`,
    );
  let loc = info.name
    ? tab.page.getByRole(info.role as any, { name: info.name, exact: true })
    : tab.page.getByRole(info.role as any);
  if (info.nth !== undefined) loc = loc.nth(info.nth);
  return loc;
}
