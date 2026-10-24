import type { Express, Request, Response } from "express";
import { tabs } from "./browser";
import { sendTabNotFound, sendBadRequest } from "./errors";
import type { TabEntry } from "./types";

const ROLE_CASCADE = [
  "button",
  "link",
  "textbox",
  "checkbox",
  "menuitem",
  "tab",
  "radio",
  "switch",
  "option",
  "treeitem",
];

export function registerFindRoutes(app: Express): void {
  app.post("/tabs/:id/find", async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const tab: TabEntry | undefined = tabs.get(id);
    if (!tab) return sendTabNotFound(res, id);
    const t: TabEntry = tab;
    t.lastUsedAt = Date.now();

    const { query, role, limit = 10, exact = false } = req.body ?? {};
    if (!query && !role) return sendBadRequest(res, "query or role required");
    const cap = Math.min(50, Math.max(1, limit));

    const page = t.page;
    const matches: any[] = [];

    async function tryRole(r: string) {
      try {
        const locator = query
          ? page.getByRole(r as any, { name: query, exact })
          : page.getByRole(r as any);
        const all = await locator.all();
        for (const loc of all.slice(0, cap - matches.length)) {
          const name = (await loc.textContent().catch(() => "")) ?? "";
          const bbox = await loc.boundingBox().catch(() => null);
          const visible = await loc.isVisible().catch(() => false);
          const refId = `e${Object.keys(t.refs).length + 1}`;
          t.refs[refId] = { role: r, name: name.trim() };
          matches.push({
            ref: refId,
            role: r,
            name: name.trim(),
            selector: null,
            visible,
            bbox,
          });
          if (matches.length >= cap) return;
        }
      } catch {
        // role yields no matches; continue cascade
      }
    }

    if (role) {
      await tryRole(role);
    } else {
      for (const r of ROLE_CASCADE) {
        if (matches.length >= cap) break;
        await tryRole(r);
      }
      if (matches.length < cap && query) {
        try {
          const all = await page.getByText(query, { exact }).all();
          for (const loc of all.slice(0, cap - matches.length)) {
            const bbox = await loc.boundingBox().catch(() => null);
            const visible = await loc.isVisible().catch(() => false);
            const refId = `e${Object.keys(t.refs).length + 1}`;
            t.refs[refId] = { role: "text", name: query };
            matches.push({
              ref: refId,
              role: "text",
              name: query,
              selector: null,
              visible,
              bbox,
            });
          }
        } catch {
          // getByText may throw on regex-like queries; swallow
        }
      }
    }

    res.json({ matches });
  });
}
