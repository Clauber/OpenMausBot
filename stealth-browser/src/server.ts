import express from "express";
import { createServer } from "http";
import { mkdirSync } from "fs";
import {
  PORT,
  HOST,
  STATE_DIR,
  PROFILES_DIR,
  DEFAULT_PROXY,
  RESIDENTIAL_PROXY,
} from "./types";
import {
  launchBrowser,
  setBrowser,
  setBrowserServer,
  persistentSessions,
  proxyBrowsers,
  proxyBrowserServers,
  browser,
  browserServer,
} from "./browser";
import { closeAllTabs, cleanupInterval } from "./tabs";
import { registerRoutes } from "./routes";
import { registerCookieRoutes } from "./cookie-inject";
import { registerLiveViewer } from "./live-viewer";
import { registerTabsListRoutes } from "./routes-tabs-list";
import { registerFindRoutes } from "./routes-find";
import { registerKeysRoutes } from "./routes-keys";
import { registerMouseRoutes } from "./routes-mouse";
import { registerBuffersRoutes } from "./routes-buffers";
import { registerExecRoutes } from "./routes-exec";
import { registerRecordingRoutes } from "./routes-recording";

const app = express();
app.use(express.json({ limit: "25mb" }));

registerRoutes(app);
registerCookieRoutes(app);
registerTabsListRoutes(app);
registerFindRoutes(app);
registerKeysRoutes(app);
registerMouseRoutes(app);
registerBuffersRoutes(app);
registerExecRoutes(app);
registerRecordingRoutes(app);

// Error handler
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[stealth-browser] Error:", message);
    res.status(500).json({ error: message });
  },
);

// Graceful shutdown
async function shutdown(): Promise<void> {
  console.log("[stealth-browser] Shutting down...");
  clearInterval(cleanupInterval);
  await closeAllTabs();
  for (const [key, session] of persistentSessions) {
    console.log(`[stealth-browser] Closing persistent session: ${key}`);
    await session.context.close().catch(() => {});
  }
  persistentSessions.clear();
  if (browser) {
    await browser.close().catch(() => {});
    setBrowser(null);
  }
  for (const [, b] of proxyBrowsers) {
    await b.close().catch(() => {});
  }
  proxyBrowsers.clear();
  if (browserServer) {
    await browserServer.close().catch(() => {});
    setBrowserServer(null);
  }
  for (const [, s] of proxyBrowserServers) {
    await s.close().catch(() => {});
  }
  proxyBrowserServers.clear();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Start
(async () => {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    mkdirSync(PROFILES_DIR, { recursive: true });
    console.log(`[stealth-browser] Profiles dir: ${PROFILES_DIR}`);
    const result = await launchBrowser();
    setBrowser(result.browser);
    setBrowserServer(result.server);
    console.log("[stealth-browser] Browser launched (stealth + human-sim)");
    console.log(
      `[stealth-browser] CDP WebSocket: ${result.server.wsEndpoint()}`,
    );
    console.log(`[stealth-browser] State dir: ${STATE_DIR}`);
    console.log(`[stealth-browser] VPN proxy: ${DEFAULT_PROXY || "(none)"}`);
    console.log(
      `[stealth-browser] Residential proxy: ${RESIDENTIAL_PROXY || process.env.PROXY_SERVER || "(none)"}`,
    );
    console.log(
      `[stealth-browser] Routes: direct=datacenter, vpn=Surfshark, residential=home IP`,
    );

    const httpServer = createServer(app);
    registerLiveViewer(app, httpServer);

    const onListening = () => {
      console.log(`[stealth-browser] Listening on ${HOST || "*"}:${PORT}`);
      console.log(
        `[stealth-browser] Live viewer: http://localhost:${PORT}/live/{agent}?route=residential`,
      );
    };
    if (HOST) httpServer.listen(PORT, HOST, onListening);
    else httpServer.listen(PORT, onListening);
  } catch (err) {
    console.error("[stealth-browser] Failed to start:", err);
    process.exit(1);
  }
})();
