import type { Express, Request, Response } from "express";
import { tabs } from "./browser";
import { sendTabNotFound, sendBadRequest } from "./errors";

const MODIFIERS = new Set(["Control", "Meta", "Alt", "Shift", "Cmd"]);
const KEY_NAMES =
  /^([A-Za-z0-9]|F\d{1,2}|Enter|Escape|Tab|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Space|Insert)$/;
const BLOCKED = new Set(["Control+W", "Meta+W", "F12", "Control+Q", "Meta+Q"]);

function normalize(keys: string): string {
  return keys
    .split("+")
    .map((part) => (part === "Cmd" ? "Meta" : part))
    .join("+");
}

function valid(keys: string): boolean {
  const parts = keys.split("+");
  const last = parts[parts.length - 1];
  if (!KEY_NAMES.test(last)) return false;
  for (const p of parts.slice(0, -1)) if (!MODIFIERS.has(p)) return false;
  return true;
}

export function registerKeysRoutes(app: Express): void {
  app.post("/tabs/:id/keys", async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const tab = tabs.get(id);
    if (!tab) return sendTabNotFound(res, id);
    tab.lastUsedAt = Date.now();

    const body = req.body ?? {};
    let keys = body.keys;
    const delay = body.delay;
    let repeat = body.repeat ?? 1;
    if (typeof keys !== "string")
      return sendBadRequest(res, "keys must be string");
    keys = normalize(keys);
    if (!valid(keys)) return sendBadRequest(res, `invalid key syntax: ${keys}`);
    if (BLOCKED.has(keys)) return sendBadRequest(res, `blocked combo: ${keys}`);
    repeat = Math.min(50, Math.max(1, Number(repeat) || 1));

    for (let i = 0; i < repeat; i++) {
      await tab.page.keyboard.press(keys, {
        delay: delay ?? 40 + Math.random() * 50,
      });
    }
    res.json({ ok: true, keys, repeated: repeat });
  });
}
