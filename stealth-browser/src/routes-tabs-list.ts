import type { Express, Request, Response } from "express";
import { tabs } from "./browser";
import { MAX_TABS } from "./types";

export function registerTabsListRoutes(app: Express): void {
  app.get("/tabs", async (req: Request, res: Response) => {
    const agentFilter =
      typeof req.query.agent === "string" ? req.query.agent : null;
    const routeFilter =
      typeof req.query.route === "string" ? req.query.route : null;
    const out: any[] = [];
    for (const [id, tab] of tabs) {
      if (agentFilter && tab.agent !== agentFilter) continue;
      if (routeFilter && tab.route !== routeFilter) continue;
      try {
        out.push({
          id,
          agent: tab.agent ?? null,
          route: tab.route ?? null,
          url: tab.page.url(),
          title: await tab.page.title().catch(() => ""),
          persistent: tab.persistent,
          createdAt: new Date(tab.createdAt).toISOString(),
          lastUsedAt: new Date(tab.lastUsedAt).toISOString(),
        });
      } catch {
        // tab closed mid-iteration — skip
      }
    }
    res.json({ count: out.length, maxTabs: MAX_TABS, tabs: out });
  });
}
