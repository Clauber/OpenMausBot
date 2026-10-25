/**
 * Session management routes: list, get, transfer, delete
 */
import type { Request, Response, NextFunction, Express } from "express";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "fs";
import path from "path";
import type { RouteMode } from "./types";
import { STATE_DIR } from "./types";
import {
  agentContexts,
  persistentSessions,
  agentProfileDir,
  agentStatePath,
} from "./browser";
import { closeAllTabs } from "./tabs";

export function registerSessionRoutes(app: Express): void {
  app.delete(
    "/sessions",
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        await closeAllTabs();
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    },
  );

  app.get("/sessions", (_req: Request, res: Response) => {
    try {
      const files = readdirSync(STATE_DIR).filter(
        (f: string) => f.endsWith(".json") && !f.includes("fingerprint"),
      );
      const sessions: Record<string, any> = {};
      for (const file of files) {
        try {
          const data = JSON.parse(
            readFileSync(path.join(STATE_DIR, file), "utf-8"),
          );
          const cookies = data.cookies || [];
          const stat = statSync(path.join(STATE_DIR, file));
          const agent = file.replace(".json", "");
          const agentName = agent.replace(/-(vpn|residential)$/, "");
          const route = agent.includes("-vpn")
            ? "vpn"
            : agent.includes("-residential")
              ? "residential"
              : "direct";
          if (!sessions[agentName])
            sessions[agentName] = {
              routes: {},
              fingerprint: existsSync(
                path.join(STATE_DIR, `${agentName}-fingerprint.json`),
              ),
            };
          sessions[agentName].routes[route] = {
            cookies: cookies.length,
            domains: [
              ...new Set(cookies.map((c: any) => c.domain?.replace(/^\./, ""))),
            ],
            lastModified: stat.mtime.toISOString(),
          };
        } catch {
          /* skip corrupt files */
        }
      }
      for (const [key, ctx] of agentContexts) {
        if (sessions[key])
          sessions[key].activeContext = {
            tabCount: ctx.tabCount,
            route: ctx.route,
          };
      }
      res.json(sessions);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post(
    "/sessions/transfer",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { from, to, route } = req.body as {
          from?: string;
          to?: string;
          route?: string;
        };
        if (!from || !to) {
          res.status(400).json({ error: "from and to are required" });
          return;
        }
        const srcPath = agentStatePath(from, route as RouteMode);
        const fallback = agentStatePath(from);
        const source = existsSync(srcPath)
          ? srcPath
          : existsSync(fallback)
            ? fallback
            : null;
        if (!source) {
          res.status(404).json({ error: `No saved session for "${from}"` });
          return;
        }
        mkdirSync(STATE_DIR, { recursive: true });
        const data = readFileSync(source, "utf-8");
        writeFileSync(agentStatePath(to, route as RouteMode), data);
        if (route && route !== "direct")
          writeFileSync(agentStatePath(to), data);
        const srcFp = path.join(STATE_DIR, `${from}-fingerprint.json`);
        if (
          existsSync(srcFp) &&
          !existsSync(path.join(STATE_DIR, `${to}-fingerprint.json`))
        )
          writeFileSync(
            path.join(STATE_DIR, `${to}-fingerprint.json`),
            readFileSync(srcFp, "utf-8"),
          );
        const parsed = JSON.parse(data);
        res.json({
          ok: true,
          from,
          to,
          cookies: parsed.cookies?.length || 0,
          route: route || "direct",
        });
      } catch (err) {
        next(err);
      }
    },
  );

  app.get("/sessions/:agent", (req: Request, res: Response) => {
    try {
      const agent = req.params.agent as string;
      const routes: Record<string, any> = {};
      for (const r of ["direct", "vpn", "residential"] as const) {
        const p =
          r === "direct" ? agentStatePath(agent) : agentStatePath(agent, r);
        if (existsSync(p)) {
          const data = JSON.parse(readFileSync(p, "utf-8"));
          const cookies = data.cookies || [];
          routes[r] = {
            cookies: cookies.length,
            domains: [
              ...new Set(cookies.map((c: any) => c.domain?.replace(/^\./, ""))),
            ],
            origins: (data.origins || []).map((o: any) => ({
              origin: o.origin,
              localStorageItems: o.localStorage?.length || 0,
            })),
          };
        }
      }
      if (!Object.keys(routes).length) {
        res.status(404).json({ error: `No saved sessions for "${agent}"` });
        return;
      }
      const profileDir = agentProfileDir(agent);
      const pi: Record<string, { tabCount: number }> = {};
      for (const [key, session] of persistentSessions) {
        if (key.startsWith(`${agent}:`))
          pi[key.split(":")[1]] = { tabCount: session.tabCount };
      }
      const activeCtx = agentContexts.get(agent);
      res.json({
        agent,
        fingerprint: existsSync(
          path.join(STATE_DIR, `${agent}-fingerprint.json`),
        ),
        profileDir: existsSync(profileDir) ? profileDir : null,
        persistentSessions: Object.keys(pi).length ? pi : null,
        activeContext: activeCtx
          ? { tabCount: activeCtx.tabCount, route: activeCtx.route }
          : null,
        routes,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.delete("/sessions/:agent", (req: Request, res: Response) => {
    try {
      const agent = req.params.agent as string;
      let deleted = 0;
      for (const r of [undefined, "vpn", "residential"] as const) {
        const p = r ? agentStatePath(agent, r) : agentStatePath(agent);
        if (existsSync(p)) {
          unlinkSync(p);
          deleted++;
        }
      }
      if (!deleted) {
        res.status(404).json({ error: `No sessions for "${agent}"` });
        return;
      }
      res.json({ ok: true, deleted });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });
}
