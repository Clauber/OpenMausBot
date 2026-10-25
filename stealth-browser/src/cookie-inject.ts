import type { Request, Response, Express } from "express";
import { existsSync, readFileSync } from "fs";
import { getOrCreatePersistentContext } from "./browser";
import type { RouteMode } from "./types";

/**
 * Cookie injection endpoints for the stealth browser.
 * Allows injecting cookies from external sources (e.g. exported browser cookies)
 * directly into a persistent Chromium profile via Playwright's addCookies().
 */
export function registerCookieRoutes(app: Express): void {
  // POST /profiles/:agent/cookies — inject cookies into browser profile
  app.post(
    "/profiles/:agent/cookies",
    async (req: Request, res: Response): Promise<void> => {
      const agent = String(req.params.agent);
      const route = String(req.query.route || "direct") as RouteMode;
      const { cookies } = req.body as { cookies?: unknown[] };

      if (!Array.isArray(cookies) || cookies.length === 0) {
        res.status(400).json({ error: "cookies (array) is required" });
        return;
      }

      try {
        const context = await getOrCreatePersistentContext(agent, route);

        // Convert to Playwright cookie format
        const pwCookies = cookies.map((c: any) => ({
          name: String(c.name),
          value: String(c.value),
          domain: String(c.domain || ""),
          path: String(c.path || "/"),
          secure: Boolean(c.secure),
          httpOnly: Boolean(c.httpOnly),
          ...(c.expires && c.expires > 0 ? { expires: Number(c.expires) } : {}),
          ...(c.sameSite
            ? { sameSite: c.sameSite as "Strict" | "Lax" | "None" }
            : {}),
        }));

        await context.addCookies(pwCookies);
        console.log(
          `[stealth-browser] Injected ${pwCookies.length} cookies into profile "${agent}" (route: ${route})`,
        );
        res.json({ ok: true, count: pwCookies.length, agent, route });
      } catch (err: any) {
        console.error(
          `[stealth-browser] Cookie injection failed for "${agent}": ${err.message}`,
        );
        res.status(500).json({ error: err.message });
      }
    },
  );

  // GET /profiles/:agent/cookies — export cookies from browser profile
  app.get(
    "/profiles/:agent/cookies",
    async (req: Request, res: Response): Promise<void> => {
      const agent = String(req.params.agent);
      const route = String(req.query.route || "direct") as RouteMode;
      const domain = req.query.domain as string | undefined;

      try {
        const context = await getOrCreatePersistentContext(agent, route);
        let cookies = await context.cookies();
        if (domain) {
          cookies = cookies.filter((c) => c.domain.includes(domain));
        }
        res.json({ agent, route, count: cookies.length, cookies });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // POST /profiles/:agent/cookies/file — inject from a JSON file path on disk
  app.post(
    "/profiles/:agent/cookies/file",
    async (req: Request, res: Response): Promise<void> => {
      const agent = String(req.params.agent);
      const route = String(req.query.route || "direct") as RouteMode;
      const { path: filePath } = req.body as { path?: string };

      if (!filePath) {
        res.status(400).json({ error: "path (string) is required" });
        return;
      }

      if (!existsSync(filePath)) {
        res.status(404).json({ error: `File not found: ${filePath}` });
        return;
      }

      try {
        const raw = readFileSync(filePath, "utf-8");
        const cookies = JSON.parse(raw);
        if (!Array.isArray(cookies)) {
          res.status(400).json({ error: "File must contain a JSON array" });
          return;
        }

        const context = await getOrCreatePersistentContext(agent, route);
        const pwCookies = cookies.map((c: any) => ({
          name: String(c.name),
          value: String(c.value),
          domain: String(c.domain || ""),
          path: String(c.path || "/"),
          secure: Boolean(c.secure),
          httpOnly: Boolean(c.httpOnly),
          ...(c.expires && c.expires > 0 ? { expires: Number(c.expires) } : {}),
          ...(c.sameSite
            ? { sameSite: c.sameSite as "Strict" | "Lax" | "None" }
            : {}),
        }));

        await context.addCookies(pwCookies);
        console.log(
          `[stealth-browser] Injected ${pwCookies.length} cookies from ${filePath} into profile "${agent}"`,
        );
        res.json({
          ok: true,
          count: pwCookies.length,
          agent,
          route,
          source: filePath,
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );
}
