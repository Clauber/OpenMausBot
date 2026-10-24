import type { Express, Request, Response } from "express";
import { tabs } from "./browser";
import { sendTabNotFound, sendBadRequest } from "./errors";

export function registerExecRoutes(app: Express): void {
  app.post("/tabs/:id/exec", async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const tab = tabs.get(id);
    if (!tab) return sendTabNotFound(res, id);
    tab.lastUsedAt = Date.now();

    const { script, args = [], timeout = 10_000 } = req.body ?? {};
    if (typeof script !== "string")
      return sendBadRequest(res, "script must be string");
    const cap = Math.min(60_000, Math.max(100, Number(timeout) || 10_000));

    // Build a real Function object and pass it to page.evaluate; Playwright
    // serializes fn.toString() across the bridge. Strings with function literals
    // are NOT reliably evaluated by patchright, but strings-of-expressions and
    // real Function objects both work.
    const isFunction = /^\s*(\(|function|async)/.test(script);
    const looksLikeStatement =
      /[;{}]/.test(script) ||
      /^\s*(const|let|var|if|for|while|throw|return)\b/.test(script);
    let body: string;
    if (isFunction) {
      body = `return (${script})(...args);`;
    } else if (looksLikeStatement) {
      body = script;
    } else {
      body = `return (${script});`;
    }
    const fn = new Function("args", body) as (a: unknown[]) => unknown;

    const start = Date.now();
    try {
      const result = await Promise.race([
        tab.page.evaluate(fn, Array.isArray(args) ? args : [args]),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("exec_timeout")), cap),
        ),
      ]);
      const type = result === null ? "null" : typeof result;
      const serializable =
        type === "string" ||
        type === "number" ||
        type === "boolean" ||
        type === "object" ||
        type === "null" ||
        type === "undefined";
      res.json({
        ok: true,
        result: serializable ? result : String(result),
        type: serializable ? type : "unsupported",
        durationMs: Date.now() - start,
      });
    } catch (err: any) {
      res.json({
        ok: false,
        error: err?.message ?? String(err),
        stack: err?.stack ?? null,
        durationMs: Date.now() - start,
      });
    }
  });
}
