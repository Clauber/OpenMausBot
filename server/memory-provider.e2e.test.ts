// Semantic memory provider, end to end against a loopback fake embeddings +
// search service: off by default, merged and deduped when on, markdown-only on
// failure, and the key held by reference only.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { appConfigSchema, DATA_DIR, syncCredentialEnv } from "./config.ts";
import { describeMemoryProvider, PROVIDER_TIMEOUT_MS, resolveMemoryProvider } from "./memory-provider.ts";
import { closeMessageDb } from "./message-db.ts";
import { buildRecall, buildRecallWith, PROVIDER_HITS, RECALL_MAX_CHARS } from "./recall.ts";
import { writeMemoryTopic, WORKSPACES_DIR } from "./workspace.ts";

const BOT = "bot-provider-test";
const SECRET = "sk-fixture-secret-123456";
const QUERY = "where is the invoice folder";
const input = { botId: BOT, message: QUERY, threadIds: [], label: () => "", author: () => "" };

let server: Server;
let base = "";
let mode: "ok" | "500" | "hang" = "ok";
let results: Array<{ text: string; source?: string; score?: number }> = [];
let seenAuth: Array<string | undefined> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seenAuth.push(req.headers.authorization);
    if (mode === "hang") return;
    if (mode === "500") {
      res.statusCode = 500;
      res.end(`boom ${SECRET}`);
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/embeddings") res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }));
      else if (req.url === "/v1/search") res.end(JSON.stringify({ results }));
      else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(WORKSPACES_DIR, { recursive: true, force: true });
  mode = "ok";
  seenAuth = [];
  results = [];
  delete process.env.OMB_MEMORY_PROVIDER_KEY;
  writeMemoryTopic(BOT, "invoices.md", "- The invoice folder is Documents/Finance/Invoices\n");
});

const enabledCfg = { memoryProvider: { enabled: true, kind: "generic-openai-embeddings" as const, url: base } };
const cfgOn = () => ({ memoryProvider: { ...enabledCfg.memoryProvider, url: base } });

describe("(a) off by default", () => {
  it("resolves no provider and recall is byte-identical to the base path", async () => {
    expect(resolveMemoryProvider({})).toBeNull();
    expect(resolveMemoryProvider({ memoryProvider: { kind: "generic-openai-embeddings", url: base } })).toBeNull();
    const baseline = buildRecall(input)!;
    expect(baseline.text).toContain("Documents/Finance/Invoices");
    const viaProvider = await buildRecallWith(input, resolveMemoryProvider({}));
    expect(viaProvider).toEqual({ ...baseline, provider: 0 });
    expect(seenAuth).toEqual([]);
  });
});

describe("(b) enabled: merged, deduped, capped", () => {
  it("adds provider hits with a badge and drops the one markdown already said", async () => {
    results = [
      { text: "The invoice folder is Documents/Finance/Invoices", source: "dup", score: 0.99 },
      { text: "Scanned invoices from 2025 live on the NAS under /volume1/finance", source: "nas-notes", score: 0.8 },
      { text: "Accounting prefers PDFs named by vendor and month", source: "ops", score: 0.7 },
    ];
    const block = (await buildRecallWith(input, resolveMemoryProvider(cfgOn())))!;
    expect(block.notes).toBe(1);
    expect(block.provider).toBe(2);
    expect(block.text).toContain("provider:embeddings · nas-notes");
    expect(block.text).toContain("provider:embeddings · ops");
    expect(block.text).not.toContain("· dup");
    expect(block.text.split("Documents/Finance/Invoices")).toHaveLength(2);
    // markdown first, provider after
    expect(block.text.indexOf("memory/invoices.md")).toBeLessThan(block.text.indexOf("provider:embeddings"));
  });

  it("caps provider passages and never exceeds the recall budget", async () => {
    results = Array.from({ length: 10 }, (_, i) => ({ text: `distinct provider passage number ${i} ${"x".repeat(4_000)}`, source: `s${i}`, score: 1 - i / 100 }));
    const block = (await buildRecallWith(input, resolveMemoryProvider(cfgOn())))!;
    expect(block.provider).toBeLessThanOrEqual(PROVIDER_HITS);
    expect(block.text.length).toBeLessThanOrEqual(RECALL_MAX_CHARS);
    expect(block.notes).toBe(1);
  });
});

describe("(c) provider failure is markdown-only", () => {
  beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));

  it("survives a 500", async () => {
    mode = "500";
    const baseline = buildRecall(input)!;
    const block = await buildRecallWith(input, resolveMemoryProvider(cfgOn()));
    expect(block).toEqual({ ...baseline, provider: 0 });
  });

  it("gives up on a hung provider at the 2s deadline", async () => {
    mode = "hang";
    const started = Date.now();
    const block = await buildRecallWith(input, resolveMemoryProvider(cfgOn()));
    expect(Date.now() - started).toBeLessThan(PROVIDER_TIMEOUT_MS + 1_000);
    expect(block?.provider).toBe(0);
    expect(block?.notes).toBe(1);
  }, 10_000);

  it("stub adapters refuse until configured and never fail the turn", async () => {
    const stub = resolveMemoryProvider({ memoryProvider: { enabled: true, kind: "supermemory", url: base } });
    await expect(stub!.recall("q", { limit: 3 })).rejects.toThrow("not configured");
    const block = await buildRecallWith(input, stub);
    expect(block?.provider).toBe(0);
    expect(block?.notes).toBe(1);
  });
});

describe("(d) key by reference, never logged or echoed", () => {
  it("sends the referenced key as a bearer, and nothing else sees it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    syncCredentialEnv({ memoryProvider: { key: SECRET } });
    const cfg = { memoryProvider: { ...cfgOn().memoryProvider, apiKeyRef: "OMB_MEMORY_PROVIDER_KEY", key: SECRET } };
    results = [{ text: "an unrelated provider passage about invoices", source: "x", score: 1 }];
    await buildRecallWith(input, resolveMemoryProvider(cfg));
    expect(seenAuth.every((auth) => auth === `Bearer ${SECRET}`)).toBe(true);

    mode = "500"; // the fake echoes the key in its error body
    await buildRecallWith(input, resolveMemoryProvider(cfg));
    const logged = JSON.stringify([...warn.mock.calls, ...log.mock.calls]);
    expect(logged).not.toContain(SECRET);

    expect(JSON.stringify(describeMemoryProvider(cfg))).not.toContain(SECRET);
    expect(describeMemoryProvider(cfg)).toMatchObject({ keyConfigured: true, apiKeyRef: "OMB_MEMORY_PROVIDER_KEY" });
    warn.mockRestore();
    log.mockRestore();
  });

  it("refuses a reference that names any other secret", () => {
    const parsed = appConfigSchema.partial().safeParse({ memoryProvider: { apiKeyRef: "OPENAI_API_KEY" } });
    expect(parsed.success).toBe(false);
    process.env.OPENAI_API_KEY = "must-not-leak";
    const provider = resolveMemoryProvider({ memoryProvider: { enabled: true, kind: "generic-openai-embeddings", url: base, apiKeyRef: "OPENAI_API_KEY" } });
    seenAuth = [];
    return provider!.recall("q", { limit: 1 }).catch(() => undefined).then(() => {
      expect(seenAuth.every((auth) => auth === undefined)).toBe(true);
      delete process.env.OPENAI_API_KEY;
    });
  });
});
