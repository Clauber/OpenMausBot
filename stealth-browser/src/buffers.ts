import type { Request, Response } from "patchright";
import {
  BUFFER_CAPACITY,
  type ConsoleEntry,
  type NetworkEntry,
  type TabEntry,
} from "./types";

export function pushBounded<T>(buf: T[], item: T, cap: number): void {
  buf.push(item);
  if (buf.length > cap) buf.shift();
}

export function bumpUsed(tab: TabEntry): void {
  tab.lastUsedAt = Date.now();
}

const CDP_TO_LEVEL: Record<string, ConsoleEntry["level"]> = {
  log: "log",
  info: "info",
  warning: "warn",
  error: "error",
  debug: "debug",
  dir: "log",
  dirxml: "log",
  table: "log",
  trace: "log",
  clear: "log",
  startGroup: "log",
  startGroupCollapsed: "log",
  endGroup: "log",
  assert: "error",
  profile: "log",
  profileEnd: "log",
  count: "log",
  timeEnd: "log",
};

export async function attachBuffers(tab: TabEntry): Promise<void> {
  const page = tab.page;

  // Patchright's stealth patches suppress `page.on("console")`; use CDP directly.
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Runtime.enable");
    cdp.on("Runtime.consoleAPICalled", (ev: any) => {
      const text = (ev.args ?? [])
        .map((a: any) =>
          a.value !== undefined ? String(a.value) : (a.description ?? ""),
        )
        .join(" ");
      const entry: ConsoleEntry = {
        ts: new Date().toISOString(),
        level: CDP_TO_LEVEL[ev.type] ?? "log",
        text,
        source: ev.stackTrace?.callFrames?.[0]
          ? {
              url: ev.stackTrace.callFrames[0].url ?? "",
              line: ev.stackTrace.callFrames[0].lineNumber ?? 0,
              col: ev.stackTrace.callFrames[0].columnNumber ?? 0,
            }
          : null,
      };
      pushBounded(tab.consoleBuffer, entry, BUFFER_CAPACITY);
    });
  } catch {
    // CDP attach failed (tab closed etc.) — skip console capture for this tab.
  }

  // Pair requests with responses via request reference.
  // WeakMap allows GC; if the entry is still in the buffer it holds the data anyway.
  const inflight = new WeakMap<
    Request,
    { startedAt: number; entry: NetworkEntry }
  >();

  page.on("request", (req: Request) => {
    const startedAt = Date.now();
    const entry: NetworkEntry = {
      ts: new Date().toISOString(),
      method: req.method(),
      url: req.url(),
      type: req.resourceType(),
      status: null,
      reqHeaders: req.headers(),
      resHeaders: {},
      reqSize: req.postDataBuffer()?.length ?? null,
      resSize: null,
      durationMs: null,
      failed: false,
    };
    pushBounded(tab.networkBuffer, entry, BUFFER_CAPACITY);
    inflight.set(req, { startedAt, entry });
  });

  page.on("response", async (res: Response) => {
    const meta = inflight.get(res.request());
    if (!meta) return;
    meta.entry.status = res.status();
    meta.entry.resHeaders = res.headers();
    meta.entry.durationMs = Date.now() - meta.startedAt;
    try {
      const buf = await res.body().catch(() => null);
      meta.entry.resSize = buf?.length ?? null;
    } catch {
      meta.entry.resSize = null;
    }
  });

  page.on("requestfailed", (req: Request) => {
    const meta = inflight.get(req);
    if (!meta) return;
    meta.entry.failed = true;
    meta.entry.failureText = req.failure()?.errorText ?? undefined;
    meta.entry.durationMs = Date.now() - meta.startedAt;
  });
}
