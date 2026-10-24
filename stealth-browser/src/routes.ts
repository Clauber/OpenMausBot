/**
 * Main route registration — tab lifecycle + delegates to sub-modules.
 */
import type { Request, Response, NextFunction, Express } from "express";
import { v4 as uuidv4 } from "uuid";
import { mkdirSync } from "fs";
import type { RouteMode, TabEntry } from "./types";
import { MAX_TABS, DEFAULT_PROXY, RESIDENTIAL_PROXY } from "./types";
import { buildRefSnapshot } from "./stealth";
import { attachBuffers } from "./buffers";
import {
  tabs,
  persistentSessions,
  browserServer,
  proxyBrowserServers,
  getOrCreatePersistentContext,
  agentProfileDir,
  agentStatePath,
} from "./browser";
import { touchTab, createTab, closeTab, saveAgentState } from "./tabs";
import { registerInteractionRoutes } from "./routes-interaction";
import { registerSessionRoutes } from "./routes-sessions";
import { registerContentRoutes } from "./routes-content";

export function registerRoutes(app: Express): void {
  // --- Health & CDP ---
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", tabs: tabs.size, maxTabs: MAX_TABS });
  });

  app.get("/cdp-url", (_req: Request, res: Response) => {
    const endpoints: Record<string, string> = {};
    if (browserServer) endpoints.direct = browserServer.wsEndpoint();
    for (const [proxy, server] of proxyBrowserServers) {
      if (proxy === DEFAULT_PROXY) endpoints.vpn = server.wsEndpoint();
      else if (proxy === RESIDENTIAL_PROXY)
        endpoints.residential = server.wsEndpoint();
    }
    if (Object.keys(endpoints).length === 0) {
      res.status(503).json({ error: "No browser servers running yet." });
      return;
    }
    res.json({
      endpoints,
      hint: "Connect with: chromium.connect(wsEndpoint). Stealth evasions are active.",
    });
  });

  // --- Bridge (persistent session for external tools) ---
  app.get(
    "/bridge/:agent",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const agent = req.params.agent as string;
        const route = (req.query.route as RouteMode) || "residential";
        const key = `${agent}:${route}`;
        let session = persistentSessions.get(key);
        if (!session) {
          await getOrCreatePersistentContext(agent, route);
          session = persistentSessions.get(key);
        }
        if (!session) {
          res
            .status(500)
            .json({ error: "Failed to create persistent session" });
          return;
        }
        session.lastAccess = Date.now();
        try {
          const infoResp = await fetch(
            `http://127.0.0.1:${session.debugPort}/json/version`,
          );
          const info = (await infoResp.json()) as any;
          res.json({
            agent,
            route,
            profileDir: agentProfileDir(agent),
            cdpPort: session.debugPort,
            webSocketDebuggerUrl: info.webSocketDebuggerUrl,
            devtoolsFrontendUrl: `devtools://devtools/bundled/inspector.html?ws=127.0.0.1:${session.debugPort}${info.webSocketDebuggerUrl?.replace(/^ws:\/\/[^/]+/, "") || ""}`,
            hint: `Connect via: chromium.connectOverCDP("http://localhost:${session.debugPort}")`,
          });
        } catch {
          res.json({
            agent,
            route,
            profileDir: agentProfileDir(agent),
            cdpPort: session.debugPort,
            hint: `CDP port ${session.debugPort} allocated but not responding yet.`,
          });
        }
      } catch (err) {
        next(err);
      }
    },
  );

  // Export a persistent profile's cookies/localStorage as a Playwright
  // storage_state JSON file. Useful for headless auth handoff (e.g. Google Meet)
  // after a human signs in through /live/<agent> on a machine with no X server.
  app.post(
    "/profiles/:agent/storage_state",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const agent = req.params.agent as string;
        const route = ((req.query.route as string) || req.body?.route || "direct") as RouteMode;
        const key = `${agent}:${route}`;
        let session = persistentSessions.get(key);
        if (!session) {
          await getOrCreatePersistentContext(agent, route);
          session = persistentSessions.get(key);
        }
        if (!session) {
          res.status(500).json({ error: "Failed to create persistent session" });
          return;
        }
        session.lastAccess = Date.now();
        const requestedPath = (req.body?.path as string | undefined)?.trim();
        const outputPath = requestedPath || agentStatePath(agent, route);
        mkdirSync(outputPath.split("/").slice(0, -1).join("/") || ".", { recursive: true });
        const state = await session.context.storageState({ path: outputPath });
        res.json({
          ok: true,
          agent,
          route,
          path: outputPath,
          cookies: state.cookies.length,
          origins: state.origins.length,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // --- Tab creation ---
  app.post("/tabs", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { url, agent, proxy, route, persistent } = req.body as {
        url?: string;
        agent?: string;
        proxy?: boolean;
        route?: RouteMode;
        persistent?: boolean;
      };
      if (!url) {
        res.status(400).json({ error: "url is required" });
        return;
      }
      if (tabs.size >= MAX_TABS) {
        // Opportunistic GC: close any idle >STALE_TAB_MS before rejecting.
        const staleMs = parseInt(
          process.env.STALE_TAB_MS ?? String(30 * 60 * 1000),
          10,
        );
        const now = Date.now();
        const candidates = [...tabs.entries()].filter(
          ([, t]) => now - t.lastUsedAt > staleMs,
        );
        if (candidates.length > 0) {
          // Close the oldest-used idle tab.
          candidates.sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
          const [oldestId] = candidates[0];
          await closeTab(oldestId);
        }
      }
      if (tabs.size >= MAX_TABS) {
        res.status(429).json({ error: `Max tabs limit (${MAX_TABS}) reached` });
        return;
      }
      const resolvedRoute: RouteMode =
        route ?? (proxy === true ? "vpn" : "direct");
      if (agent && persistent !== false) {
        const ctx = await getOrCreatePersistentContext(agent, resolvedRoute);
        const page = await ctx.newPage();
        await page.route(
          "**/{fingerprint,fp,collect,track,beacon,pixel}.{js,gif,png}",
          (r) => r.abort(),
        );
        const id = uuidv4();
        const nowPersist = Date.now();
        const persistEntry: TabEntry = {
          context: ctx,
          page,
          lastAccess: nowPersist,
          lastUsedAt: nowPersist,
          createdAt: nowPersist,
          persistent: true,
          agent,
          route: resolvedRoute,
          refs: {},
          consoleBuffer: [],
          networkBuffer: [],
        };
        tabs.set(id, persistEntry);
        await attachBuffers(persistEntry);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        const key = `${agent}:${resolvedRoute}`;
        const session = persistentSessions.get(key);
        if (session) {
          session.tabCount++;
          session.lastAccess = Date.now();
        }
        res.json({
          id,
          agent,
          route: resolvedRoute,
          persistent: true,
          profileDir: agentProfileDir(agent),
        });
        return;
      }
      const id = await createTab(url, agent, resolvedRoute);
      res.status(201).json({ id, agent: agent ?? null, route: resolvedRoute });
    } catch (err) {
      next(err);
    }
  });

  // --- Tab snapshot & screenshot ---
  app.get(
    "/tabs/:id/snapshot",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tab = touchTab(req.params.id as string);
        if (!tab) {
          res.status(404).json({ error: "Tab not found" });
          return;
        }
        const format = (req.query.format as string) ?? "aria";
        let snapshot: string;
        if (format === "text") {
          snapshot = await tab.page
            .locator("body")
            .innerText({ timeout: 10000 });
        } else {
          const raw = await tab.page.locator("body").ariaSnapshot();
          const { snapshot: enhanced, refs } = buildRefSnapshot(raw);
          tab.refs = refs;
          snapshot = enhanced;
        }
        res.json({
          snapshot,
          url: tab.page.url(),
          title: await tab.page.title(),
          format,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  app.get(
    "/tabs/:id/screenshot",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tab = touchTab(req.params.id as string);
        if (!tab) {
          res.status(404).json({ error: "Tab not found" });
          return;
        }
        const buffer = await tab.page.screenshot({
          type: "png",
          fullPage: false,
        });
        res.json({ screenshot: buffer.toString("base64") });
      } catch (err) {
        next(err);
      }
    },
  );

  // --- Tab navigation ---
  app.post(
    "/tabs/:id/navigate",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tab = touchTab(req.params.id as string);
        if (!tab) {
          res.status(404).json({ error: "Tab not found" });
          return;
        }
        const { url } = req.body as { url?: string };
        if (!url) {
          res.status(400).json({ error: "url is required" });
          return;
        }
        await tab.page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        if (tab.agent) saveAgentState(tab).catch(() => {});
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    },
  );

  // --- Tab close ---
  app.delete(
    "/tabs/:id",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!tabs.has(req.params.id as string)) {
          res.status(404).json({ error: "Tab not found" });
          return;
        }
        await closeTab(req.params.id as string);
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    },
  );

  // --- Sub-module routes ---
  registerInteractionRoutes(app);
  registerContentRoutes(app);
  registerSessionRoutes(app);
}
