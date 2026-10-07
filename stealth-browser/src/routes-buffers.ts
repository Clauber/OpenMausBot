import type { Express, Request, Response } from "express";
import { tabs } from "./browser";
import { sendTabNotFound, sendBadRequest } from "./errors";
import type { ConsoleEntry, NetworkEntry } from "./types";

function parseLimit(q: unknown, def = 100, max = 500): number {
  const n = parseInt(String(q ?? ""), 10);
  return isNaN(n) ? def : Math.min(max, Math.max(1, n));
}

function compileRegex(p: string | undefined): RegExp | null {
  if (!p) return null;
  return new RegExp(p, "i");
}

function consoleToMarkdown(entries: ConsoleEntry[]): string {
  const rows = entries.map((e) => {
    const time = e.ts.slice(11, 19);
    const src = e.source
      ? `${e.source.url.split("/").pop()}:${e.source.line}:${e.source.col}`
      : "(no location)";
    const text = e.text.replace(/\n/g, "<br>").replace(/\|/g, "\\|");
    return `| ${time} | ${e.level} | ${text} | ${src} |`;
  });
  return [
    "| time | level | text | source |",
    "|------|-------|------|--------|",
    ...rows,
  ].join("\n");
}

function networkToMarkdown(entries: NetworkEntry[]): string {
  const fmt = (n: number | null) =>
    n == null ? "-" : n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}KB`;
  const rows = entries.map((e) => {
    const time = e.ts.slice(11, 19);
    const status = e.status ?? "-";
    const dur = e.durationMs == null ? "-" : `${e.durationMs}ms`;
    const url = e.url.length > 60 ? e.url.slice(0, 57) + "..." : e.url;
    return `| ${time} | ${e.method} | ${status} | ${e.type} | ${url} | ${fmt(e.resSize)} | ${dur} |`;
  });
  return [
    "| time | method | status | type | url | size | dur |",
    "|------|--------|--------|------|-----|------|-----|",
    ...rows,
  ].join("\n");
}

function statusMatches(
  target: string | undefined,
  status: number | null,
): boolean {
  if (!target) return true;
  if (status == null) return false;
  if (/^\d+$/.test(target)) return status === parseInt(target, 10);
  if (/^\dxx$/.test(target))
    return Math.floor(status / 100) === parseInt(target[0], 10);
  if (/^>=\d+$/.test(target)) return status >= parseInt(target.slice(2), 10);
  if (/^<\d+$/.test(target)) return status < parseInt(target.slice(1), 10);
  return false;
}

export function registerBuffersRoutes(app: Express): void {
  app.get("/tabs/:id/console", (req: Request, res: Response) => {
    const id = req.params.id as string;
    const tab = tabs.get(id);
    if (!tab) return sendTabNotFound(res, id);

    let pattern: RegExp | null = null;
    try {
      pattern = compileRegex(req.query.pattern as string | undefined);
    } catch (e: any) {
      return sendBadRequest(res, `bad regex: ${e.message}`);
    }

    const levels =
      typeof req.query.level === "string"
        ? new Set(req.query.level.split(","))
        : null;
    const limit = parseLimit(req.query.limit);
    const format = req.query.format === "json" ? "json" : "markdown";

    let entries = tab.consoleBuffer.filter(
      (e) =>
        (!levels || levels.has(e.level)) && (!pattern || pattern.test(e.text)),
    );
    if (entries.length > limit) entries = entries.slice(-limit);

    // Snapshot-then-clear-then-respond: never lose entries between filter and clear.
    if (req.query.clear === "true") tab.consoleBuffer.length = 0;

    if (format === "json") res.json({ entries });
    else res.type("text/markdown").send(consoleToMarkdown(entries));
  });

  app.get("/tabs/:id/network", (req: Request, res: Response) => {
    const id = req.params.id as string;
    const tab = tabs.get(id);
    if (!tab) return sendTabNotFound(res, id);

    let urlPattern: RegExp | null = null;
    try {
      urlPattern = compileRegex(req.query.url as string | undefined);
    } catch (e: any) {
      return sendBadRequest(res, `bad url regex: ${e.message}`);
    }

    const types =
      typeof req.query.type === "string"
        ? new Set(req.query.type.split(","))
        : null;
    const methods =
      typeof req.query.method === "string"
        ? new Set(req.query.method.split(","))
        : null;
    const status = req.query.status as string | undefined;
    const limit = parseLimit(req.query.limit);
    const format = req.query.format === "json" ? "json" : "markdown";
    const includeBody = req.query.body === "true";

    let entries = tab.networkBuffer.filter(
      (e) =>
        (!types || types.has(e.type)) &&
        (!methods || methods.has(e.method)) &&
        (!urlPattern || urlPattern.test(e.url)) &&
        statusMatches(status, e.status),
    );
    if (entries.length > limit) entries = entries.slice(-limit);

    if (includeBody) {
      res.set("X-Stealth-Body-Capture", "deferred-to-v2");
    }

    if (req.query.clear === "true") tab.networkBuffer.length = 0;

    if (format === "json") res.json({ entries });
    else res.type("text/markdown").send(networkToMarkdown(entries));
  });
}
