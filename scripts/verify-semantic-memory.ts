// Semantic memory provider against a loopback fake embeddings + search
// service, in a throwaway data directory. Run it directly:
//   node --experimental-strip-types scripts/verify-semantic-memory.ts
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECRET = "sk-verify-secret-987654";
const dataDir = mkdtempSync(join(tmpdir(), "omb-semantic-memory-"));
process.env.OMB_DATA_DIR = dataDir;

const { describeMemoryProvider, resolveMemoryProvider } = await import("../server/memory-provider.ts");
const { buildRecall, buildRecallWith } = await import("../server/recall.ts");
const { syncCredentialEnv } = await import("../server/config.ts");
const { writeMemoryTopic } = await import("../server/workspace.ts");

let mode: "ok" | "500" | "hang" = "ok";
const auth: Array<string | undefined> = [];
const fake = createServer((req, res) => {
  auth.push(req.headers.authorization);
  if (mode === "hang") return;
  if (mode === "500") { res.statusCode = 500; res.end(`boom ${SECRET}`); return; }
  req.resume();
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    res.end(req.url === "/v1/embeddings"
      ? JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] })
      : JSON.stringify({ results: [
        { text: "The invoice folder is Documents/Finance/Invoices", source: "dup", score: 0.9 },
        { text: "Scanned invoices from 2025 live on the NAS", source: "nas", score: 0.8 },
      ] }));
  });
});
await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;

const logs: string[] = [];
for (const level of ["log", "warn", "error"] as const) console[level] = (...args: unknown[]) => { logs.push(args.join(" ")); };
const say = (line: string) => process.stdout.write(`${line}\n`);

try {
  writeMemoryTopic("verify-bot", "invoices.md", "- The invoice folder is Documents/Finance/Invoices\n");
  const input = { botId: "verify-bot", message: "where is the invoice folder", threadIds: [], label: () => "", author: () => "" };
  const base = buildRecall(input)!;
  const cfg = { memoryProvider: { enabled: true, kind: "generic-openai-embeddings" as const, url } };

  assert.equal(resolveMemoryProvider({}), null);
  assert.deepEqual(await buildRecallWith(input, resolveMemoryProvider({})), { ...base, provider: 0 });
  assert.equal(auth.length, 0);
  say("(a) PASS disabled by default: recall identical to base, fake saw 0 requests");

  const merged = (await buildRecallWith(input, resolveMemoryProvider(cfg)))!;
  assert.equal(merged.notes, 1);
  assert.equal(merged.provider, 1);
  assert.ok(merged.text.includes("provider:embeddings · nas") && !merged.text.includes("· dup"));
  say(`(b) PASS enabled: ${merged.notes} markdown + ${merged.provider} provider passage, duplicate dropped, badge present`);

  mode = "500";
  assert.deepEqual(await buildRecallWith(input, resolveMemoryProvider(cfg)), { ...base, provider: 0 });
  mode = "hang";
  const started = Date.now();
  assert.deepEqual(await buildRecallWith(input, resolveMemoryProvider(cfg)), { ...base, provider: 0 });
  say(`(c) PASS 500 and hang both fall back to markdown-only (hang gave up after ${Date.now() - started} ms)`);

  mode = "ok";
  auth.length = 0;
  syncCredentialEnv({ memoryProvider: { key: SECRET } });
  const withKey = { memoryProvider: { ...cfg.memoryProvider, apiKeyRef: "OMB_MEMORY_PROVIDER_KEY" } };
  await buildRecallWith(input, resolveMemoryProvider(withKey));
  mode = "500";
  await buildRecallWith(input, resolveMemoryProvider(withKey));
  assert.ok(auth.length > 0 && auth.slice(0, 2).every((a) => a === `Bearer ${SECRET}`));
  assert.ok(!logs.join("\n").includes(SECRET));
  assert.ok(!JSON.stringify(describeMemoryProvider(withKey)).includes(SECRET));
  say("(d) PASS key sent only as bearer via apiKeyRef; absent from logs and the UI status object");
} finally {
  fake.closeAllConnections();
  fake.close();
  rmSync(dataDir, { recursive: true, force: true });
}
