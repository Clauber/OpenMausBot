import express from "express";
import type { Server } from "http";
import { createServer } from "http";
import { afterAll, beforeAll } from "vitest";
import {
  launchBrowser,
  setBrowser,
  setBrowserServer,
  browser as browserSingleton,
} from "../src/browser";
import { closeAllTabs } from "../src/tabs";
import { registerRoutes } from "../src/routes";
import { registerCookieRoutes } from "../src/cookie-inject";
import { registerTabsListRoutes } from "../src/routes-tabs-list";
import { registerFindRoutes } from "../src/routes-find";
import { registerKeysRoutes } from "../src/routes-keys";
import { registerMouseRoutes } from "../src/routes-mouse";
import { registerBuffersRoutes } from "../src/routes-buffers";
import { registerExecRoutes } from "../src/routes-exec";
import { registerRecordingRoutes } from "../src/routes-recording";

let server: Server | null = null;
let baseUrl = "";
let initialized = false;

export function getBaseUrl(): string {
  if (!baseUrl)
    throw new Error("setup not run — getBaseUrl called before beforeAll");
  return baseUrl;
}

beforeAll(async () => {
  if (initialized) return;
  initialized = true;

  if (!browserSingleton) {
    const launched = await launchBrowser();
    setBrowser(launched.browser);
    setBrowserServer(launched.server);
  }

  const app = express();
  app.use(express.json({ limit: "10mb" }));
  registerRoutes(app);
  registerCookieRoutes(app);
  registerTabsListRoutes(app);
  registerFindRoutes(app);
  registerKeysRoutes(app);
  registerMouseRoutes(app);
  registerBuffersRoutes(app);
  registerExecRoutes(app);
  registerRecordingRoutes(app);
  // New route registrations land here as endpoint tasks add them.

  server = createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const addr = server!.address();
  if (typeof addr === "object" && addr) {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
}, 60_000);

afterAll(async () => {
  await closeAllTabs();
  if (server) await new Promise<void>((r) => server!.close(() => r()));
});
