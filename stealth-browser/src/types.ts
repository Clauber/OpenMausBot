import type { BrowserContext, Page } from "patchright";

// --- Environment config ---
export const PORT = parseInt(process.env.PORT ?? "9377", 10);
// Empty listens on every interface (the old behaviour); set 127.0.0.1 where
// the service has no auth and only local clients should reach it.
export const HOST = process.env.HOST ?? "";
// "1280x720" fixes every persistent profile's page size, inside the larger
// fingerprinted screen as a real window would be. OpenMausBot's live view
// maps input onto a 1280x720 page; unset keeps the fingerprint's full screen.
export const VIEWPORT = (() => {
  const match = /^(\d{3,4})x(\d{3,4})$/.exec(process.env.VIEWPORT ?? "");
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
})();
export const DEBUG_PORT_BASE = parseInt(process.env.DEBUG_PORT_BASE ?? "9500", 10);
export const MAX_TABS = parseInt(process.env.MAX_TABS ?? "5", 10);
export const TAB_TIMEOUT_MS = parseInt(
  process.env.TAB_TIMEOUT_MS ?? "300000",
  10,
);
export const STATE_DIR = process.env.STATE_DIR ?? "/data/browser-state";
export const PROFILES_DIR =
  process.env.PROFILES_DIR ?? "/data/browser-profiles";
export const DEFAULT_PROXY = process.env.STEALTH_PROXY_URL ?? "";
export const RESIDENTIAL_PROXY = process.env.RESIDENTIAL_PROXY_URL ?? "";
export const PERSISTENT_IDLE_MS = parseInt(
  process.env.PERSISTENT_IDLE_MS ?? "600000",
  10,
);

// --- Types ---
export type RouteMode = "direct" | "vpn" | "residential";

export interface PersistentSession {
  context: BrowserContext;
  lastAccess: number;
  route: RouteMode;
  tabCount: number;
  debugPort: number;
}

export interface RefInfo {
  role: string;
  name?: string;
  nth?: number;
}
export type RefMap = Record<string, RefInfo>;

export interface TabEntry {
  context: BrowserContext;
  page: Page;
  lastAccess: number;
  lastUsedAt: number;
  createdAt: number;
  persistent: boolean;
  agent?: string;
  route?: RouteMode;
  refs: RefMap;
  consoleBuffer: ConsoleEntry[];
  networkBuffer: NetworkEntry[];
  activeRecordingId?: string;
}

// --- Stateful buffers (Plan A additions) ---
export const BUFFER_CAPACITY = parseInt(
  process.env.BUFFER_CAPACITY ?? "500",
  10,
);

export interface ConsoleEntry {
  ts: string;
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
  source: { url: string; line: number; col: number } | null;
}

export interface NetworkEntry {
  ts: string;
  method: string;
  url: string;
  type: string;
  status: number | null;
  reqHeaders: Record<string, string>;
  resHeaders: Record<string, string>;
  reqSize: number | null;
  resSize: number | null;
  durationMs: number | null;
  failed: boolean;
  failureText?: string;
  reqBody?: string;
  resBody?: string;
}

export interface Recording {
  id: string;
  tabId: string;
  startedAt: number;
  fps: number;
  maxDurationMs: number;
  framesDir: string;
  frameCount: number;
  cdpSession: any;
  finalGifPath?: string;
  finalSizeBytes?: number;
}
