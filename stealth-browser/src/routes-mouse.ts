import type { Express, Request, Response } from "express";
import { tabs } from "./browser";
import { sendTabNotFound, sendBadRequest } from "./errors";

export function registerMouseRoutes(app: Express): void {
  app.post("/tabs/:id/mouse", async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const tab = tabs.get(id);
    if (!tab) return sendTabNotFound(res, id);
    tab.lastUsedAt = Date.now();

    const { action } = req.body ?? {};
    const page = tab.page;
    const m = page.mouse;
    try {
      switch (action) {
        case "click": {
          const { x, y, button = "left", clickCount = 1 } = req.body;
          await m.move(x, y, { steps: 8 });
          await m.click(x, y, { button, clickCount });
          return res.json({ ok: true, action, position: { x, y } });
        }
        case "move": {
          const { x, y, steps = 8 } = req.body;
          await m.move(x, y, { steps });
          return res.json({ ok: true, action, position: { x, y } });
        }
        case "down": {
          const { x, y, button = "left" } = req.body;
          await m.move(x, y, { steps: 6 });
          await m.down({ button });
          return res.json({ ok: true, action, position: { x, y } });
        }
        case "up": {
          const { x, y, button = "left" } = req.body;
          await m.move(x, y, { steps: 6 });
          await m.up({ button });
          return res.json({ ok: true, action, position: { x, y } });
        }
        case "drag": {
          const { from, to, steps = 16 } = req.body;
          await m.move(from.x, from.y, { steps: 6 });
          await m.down();
          await m.move(to.x, to.y, { steps });
          await m.up();
          return res.json({ ok: true, action, position: to });
        }
        case "scroll": {
          const { x, y, deltaX = 0, deltaY = 0 } = req.body;
          await m.move(x, y, { steps: 4 });
          await m.wheel(deltaX, deltaY);
          return res.json({ ok: true, action, position: { x, y } });
        }
        case "scrollTo": {
          const { y } = req.body;
          await page.evaluate(
            (targetY) => window.scrollTo({ top: targetY, behavior: "smooth" }),
            y,
          );
          return res.json({ ok: true, action, position: { x: 0, y } });
        }
        case "hover": {
          const { x, y } = req.body;
          await m.move(x, y, { steps: 8 });
          return res.json({ ok: true, action, position: { x, y } });
        }
        default:
          return sendBadRequest(res, `unknown action: ${action}`);
      }
    } catch (err: any) {
      return sendBadRequest(res, err?.message ?? String(err));
    }
  });
}
