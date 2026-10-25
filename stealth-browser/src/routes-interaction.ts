/**
 * Browser interaction routes: click, type, check, select, upload, scroll, wait, save
 */
import type { Request, Response, NextFunction, Express } from "express";
import { touchTab, resolveRef, saveAgentState } from "./tabs";
import {
  humanClickLocator,
  humanClick,
  humanType,
  humanScroll,
  humanMove,
  randomDelay,
} from "./human-helpers";

function requireTab(req: Request, res: Response) {
  const tab = touchTab(req.params.id as string);
  if (!tab) {
    res.status(404).json({ error: "Tab not found" });
    return null;
  }
  return tab;
}

export function registerInteractionRoutes(app: Express): void {
  app.post(
    "/tabs/:id/click",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tab = requireTab(req, res);
        if (!tab) return;
        const { selector, text, ref, role } = req.body as {
          selector?: string;
          text?: string;
          ref?: string;
          role?: string;
        };
        if (!selector && !text && !ref) {
          res
            .status(400)
            .json({ error: "One of ref, text, or selector is required" });
          return;
        }
        if (ref) {
          await humanClickLocator(tab.page, resolveRef(tab, ref));
        } else if (role && text) {
          await humanClickLocator(
            tab.page,
            tab.page.getByRole(role as any, { name: text, exact: true }),
          );
        } else if (text) {
          const rolesToTry = [
            "button",
            "link",
            "checkbox",
            "menuitem",
            "tab",
            "radio",
            "switch",
            "option",
            "treeitem",
          ];
          let found = false;
          for (const r of rolesToTry) {
            const loc = tab.page.getByRole(r as any, {
              name: text,
              exact: false,
            });
            if ((await loc.count()) > 0) {
              await humanClickLocator(tab.page, loc.first());
              found = true;
              break;
            }
          }
          if (!found)
            await humanClickLocator(
              tab.page,
              tab.page.getByText(text, { exact: false }).first(),
            );
        } else {
          await humanClick(tab.page, selector!);
        }
        await tab.page
          .waitForLoadState("domcontentloaded", { timeout: 10000 })
          .catch(() => {});
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    "/tabs/:id/type",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tab = requireTab(req, res);
        if (!tab) return;
        const { selector, label, ref, text, clear } = req.body as {
          selector?: string;
          label?: string;
          ref?: string;
          text?: string;
          clear?: boolean;
        };
        if ((!selector && !label && !ref) || text === undefined) {
          res
            .status(400)
            .json({ error: "(ref, label, or selector) and text are required" });
          return;
        }
        if (ref) {
          const el = resolveRef(tab, ref);
          if (clear !== false) await el.fill(text, { timeout: 10000 });
          else {
            await el.click({ timeout: 10000 });
            await el.pressSequentially(text, {
              delay: 30 + Math.random() * 80,
            });
          }
        } else if (label) {
          const el = tab.page.getByLabel(label, { exact: false }).first();
          if (clear !== false) await el.fill(text, { timeout: 10000 });
          else {
            await el.click({ timeout: 10000 });
            await el.pressSequentially(text, {
              delay: 30 + Math.random() * 80,
            });
          }
        } else if (clear) {
          await tab.page.fill(selector!, text, { timeout: 10000 });
        } else {
          await humanType(tab.page, selector!, text);
        }
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    "/tabs/:id/check",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tab = requireTab(req, res);
        if (!tab) return;
        const { ref, name, label, selector, checked } = req.body as {
          ref?: string;
          name?: string;
          label?: string;
          selector?: string;
          checked?: boolean;
        };
        if (!ref && !name && !label && !selector) {
          res.status(400).json({
            error: "One of ref, name, label, or selector is required",
          });
          return;
        }
        let el: any;
        if (ref) el = resolveRef(tab, ref);
        else if (name) {
          const cb = tab.page.getByRole("checkbox", { name, exact: true });
          el =
            (await cb.count()) > 0
              ? cb.first()
              : tab.page.getByRole("switch", { name, exact: true }).first();
        } else if (label)
          el = tab.page.getByLabel(label, { exact: false }).first();
        else el = tab.page.locator(selector!).first();
        const box = await el.boundingBox();
        if (box) {
          await humanMove(
            tab.page,
            box.x + box.width / 2,
            box.y + box.height / 2,
          );
          await randomDelay(50, 150);
        }
        if (checked !== false) await el.check({ timeout: 10000 });
        else await el.uncheck({ timeout: 10000 });
        await tab.page
          .waitForLoadState("domcontentloaded", { timeout: 5000 })
          .catch(() => {});
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    "/tabs/:id/select",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tab = requireTab(req, res);
        if (!tab) return;
        const { ref, label, selector, option } = req.body as {
          ref?: string;
          label?: string;
          selector?: string;
          option?: string;
        };
        if (!ref && !label && !selector) {
          res
            .status(400)
            .json({ error: "One of ref, label, or selector is required" });
          return;
        }
        if (!option) {
          res.status(400).json({ error: "option is required" });
          return;
        }
        const el = ref
          ? resolveRef(tab, ref)
          : label
            ? tab.page.getByLabel(label, { exact: false }).first()
            : tab.page.locator(selector!).first();
        const box = await el.boundingBox();
        if (box) {
          await humanMove(
            tab.page,
            box.x + box.width / 2,
            box.y + box.height / 2,
          );
          await randomDelay(50, 150);
        }
        await el.selectOption(option, { timeout: 10000 });
        await tab.page
          .waitForLoadState("domcontentloaded", { timeout: 5000 })
          .catch(() => {});
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    "/tabs/:id/upload",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tab = requireTab(req, res);
        if (!tab) return;
        const { ref, selector, files } = req.body as {
          ref?: string;
          selector?: string;
          files?: Array<{ name: string; content: string; mimeType?: string }>;
        };
        if (!ref && !selector) {
          res.status(400).json({ error: "ref or selector is required" });
          return;
        }
        if (!files || !files.length) {
          res.status(400).json({ error: "files array is required" });
          return;
        }
        const el = ref
          ? resolveRef(tab, ref)
          : tab.page.locator(selector!).first();
        await el.setInputFiles(
          files.map((f) => ({
            name: f.name,
            mimeType: f.mimeType ?? "application/octet-stream",
            buffer: Buffer.from(f.content, "base64"),
          })),
          { timeout: 10000 },
        );
        await tab.page
          .waitForLoadState("domcontentloaded", { timeout: 10000 })
          .catch(() => {});
        res.json({ ok: true, uploaded: files.map((f) => f.name) });
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    "/tabs/:id/filechooser",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tab = requireTab(req, res);
        if (!tab) return;
        const { ref, selector, files } = req.body as {
          ref?: string;
          selector?: string;
          files?: Array<{ name: string; content: string; mimeType?: string }>;
        };
        if (!ref && !selector) {
          res.status(400).json({ error: "ref or selector is required" });
          return;
        }
        if (!files || !files.length) {
          res.status(400).json({ error: "files array is required" });
          return;
        }
        const payloads = files.map((f) => ({
          name: f.name,
          mimeType: f.mimeType ?? "application/octet-stream",
          buffer: Buffer.from(f.content, "base64"),
        }));
        const target = ref
          ? resolveRef(tab, ref)
          : tab.page.locator(selector!).first();
        const [fc] = await Promise.all([
          tab.page.waitForEvent("filechooser", { timeout: 8000 }),
          target.click({ timeout: 5000 }),
        ]);
        await fc.setFiles(payloads);
        await tab.page.waitForTimeout(1000);
        res.json({ ok: true, uploaded: files.map((f) => f.name) });
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    "/tabs/:id/scroll",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tab = requireTab(req, res);
        if (!tab) return;
        const { direction, amount } = req.body as {
          direction?: "up" | "down";
          amount?: number;
        };
        await humanScroll(
          tab.page,
          direction === "up" ? -(amount ?? 500) : (amount ?? 500),
        );
        await new Promise((resolve) =>
          setTimeout(resolve, 300 + Math.random() * 400),
        );
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    "/tabs/:id/wait",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tab = requireTab(req, res);
        if (!tab) return;
        const { selector, timeout } = req.body as {
          selector?: string;
          timeout?: number;
        };
        if (selector)
          await tab.page.waitForSelector(selector, {
            timeout: timeout ?? 10000,
          });
        else
          await tab.page
            .waitForLoadState("networkidle", { timeout: timeout ?? 10000 })
            .catch(() => {});
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    "/tabs/:id/save",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tab = requireTab(req, res);
        if (!tab) return;
        if (!tab.agent) {
          res.status(400).json({ error: "Tab has no agent" });
          return;
        }
        await saveAgentState(tab);
        res.json({ ok: true, agent: tab.agent });
      } catch (err) {
        next(err);
      }
    },
  );
}
