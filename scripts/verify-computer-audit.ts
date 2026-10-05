// Computer audit log + instant revocation in isolated fixtures.
//   Part 1 (in-process): the real audit log, epoch watcher and cloud computer
//   tools against a loopback fake Boat — three actions, mid-action revoke with
//   timing, space-isolation refusal, row cap.
//   Part 2 (real server): the HTTP surface — takeover rows, list filters,
//   owner revoke, and the space-scope 403 — against a throwaway harness.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ComputerAuditLog, auditedComputerCall } from "../server/computer-audit.ts";
import { ComputerEpochs } from "../server/computer-epoch.ts";
import { removeTempDir } from "../server/testing/cleanup.ts";
import { launchVerificationServer } from "./control-omb.ts";

export async function verifyComputerAudit() {
  const evidence: Record<string, unknown> = {};
  const dir = mkdtempSync(join(tmpdir(), "omb-computer-audit-verify-"));
  let hold = false;
  let commandStarted: (() => void) | undefined;
  const boat = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    if ((req.url ?? "").endsWith("/commands")) {
      commandStarted?.();
      if (!hold) res.end(JSON.stringify({ exitCode: 0, stdout: "captured", stderr: "" }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((resolve) => boat.listen(0, "127.0.0.1", resolve));
  process.env.OMB_BOX_API = `http://127.0.0.1:${(boat.address() as { port: number }).port}`;
  delete process.env.OMB_CLOUD_BOAT_TOKEN;
  const tools = await import("../server/cloud-computer-tools.ts");
  const cfg = { box: { token: "synthetic-box-key" } } as never;
  const audit = new ComputerAuditLog(dir), epochs = new ComputerEpochs();
  const run = (name: string, args: Record<string, unknown>, check?: () => string | null) => auditedComputerCall(name, {
    audit, epochs, botId: "bot-1", computerId: "bot-bot-1", ...(check ? { check } : {}),
    dispatch: ({ signal, gate, assertActive }) => tools.cloudComputerRpc(
      { method: "tools/call", params: { name, arguments: args } },
      { cfg, boxId: "bx_23456789", signal, gate: () => gate(async () => ({ held: false })), assertActive: () => assertActive(() => {}) }),
  });
  try {
    // (a) three actions → three ok rows, actor bot, no typed content.
    const typed = "correct-horse-battery-staple";
    await run("type_text", { text: typed });
    await run("exec", { command: `echo ${typed}` });
    await run("click", { x: 321, y: 654 });
    const rows = audit.list("bot-bot-1");
    assert.equal(rows.length, 3);
    assert.ok(rows.every((row) => row.actor === "bot" && row.outcome === "ok"));
    const file = join(dir, "computer-audit", readdirSync(join(dir, "computer-audit"))[0]!);
    const raw = readFileSync(file, "utf8");
    assert.ok(!raw.includes(typed) && !raw.includes("321") && !raw.includes("654"), "audit file holds no typed content");
    evidence.a = { rows, fileHoldsTypedText: raw.includes(typed) };

    // (b) revoke mid-action.
    hold = true;
    const started = new Promise<void>((resolve) => { commandStarted = resolve; });
    const running = run("exec", { command: "sleep 600" });
    await started;
    const t0 = performance.now();
    const cancelled = epochs.revoke("bot-1", "the owner revoked access");
    const outcome = await running;
    const abortMs = performance.now() - t0;
    hold = false;
    assert.equal(cancelled, 1);
    assert.equal(outcome.kind, "revoked");
    assert.ok(abortMs < 250, `abort took ${abortMs}ms`);
    const cancelRow = audit.list("bot-bot-1")[0]!;
    assert.deepEqual([cancelRow.outcome, cancelRow.error], ["denied", "cancelled: the owner revoked access"]);
    evidence.b = { cancelled, abortMs: Math.round(abortMs * 10) / 10, row: cancelRow, feedback: `${cancelled} action cancelled` };

    // (c) space isolation refusal.
    const refused = await run("screenshot", {}, () => "space isolation: the computer is in another space");
    assert.equal(refused.kind, "revoked");
    const spaceRow = audit.list("bot-bot-1")[0]!;
    assert.deepEqual([spaceRow.action, spaceRow.outcome], ["screenshot", "denied"]);
    evidence.c = spaceRow;

    // (d) row cap.
    const capped = new ComputerAuditLog(join(dir, "capped"), 100);
    for (let i = 0; i < 1000; i++) capped.append({ ts: i, computerId: "c", botId: "b", actor: "bot", action: "click", outcome: "ok", durationMs: 1 });
    assert.equal(capped.size("c"), 100);
    assert.equal(capped.list("c", { limit: 5000 }).length, 100);
    evidence.d = { appended: 1000, retained: capped.size("c") };
  } finally {
    boat.closeAllConnections(); boat.close();
  }

  // Part 2: the real HTTP surface.
  const fixture = await launchVerificationServer({});
  const http: unknown[] = [];
  const api = async (method: string, path: string, body?: unknown, status = 200, headers: Record<string, string> = {}) => {
    const response = await fetch(fixture.info.url + path, { method,
      headers: { "content-type": "application/json", origin: fixture.info.url, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any;
    http.push({ method, path, status: response.status, result });
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result)}`);
    return result;
  };
  const evidencePath = `${fixture.info.logPath}.computer-audit.json`;
  try {
    const bot = (await api("POST", "/api/bots", { name: "Audit bot" }, 201)).bot;
    assert.deepEqual((await api("GET", `/api/computer-audit?botId=${bot.id}`)).rows, []);
    await api("POST", `/api/bots/${bot.id}/computer/control`, { action: "take" });
    await api("POST", `/api/bots/${bot.id}/computer/control`, { action: "release" });
    const listed = (await api("GET", `/api/computer-audit?botId=${bot.id}`)).rows;
    assert.deepEqual(listed.map((row: any) => row.action), ["takeover.release", "takeover.take"]);
    assert.ok(listed.every((row: any) => row.actor === "owner" && row.outcome === "ok"));
    assert.equal((await api("GET", `/api/computer-audit?botId=${bot.id}&action=takeover.take`)).rows.length, 1);
    assert.equal((await api("GET", `/api/computer-audit?botId=${bot.id}&outcome=denied`)).rows.length, 0);
    await api("GET", `/api/computer-audit?botId=${bot.id}&outcome=bogus`, undefined, 400);
    await api("GET", "/api/computer-audit?botId=nope", undefined, 404);
    const revoked = await api("POST", "/api/computer-audit/revoke", { botId: bot.id });
    assert.equal(revoked.cancelled, 0);
    const after = (await api("GET", `/api/computer-audit?botId=${bot.id}`)).rows;
    assert.equal(after[0].action, "revoke");
    // A bot in another space is not reachable from a scoped request.
    const work = (await api("POST", "/api/spaces", { name: "Work" }, 201)).space;
    const refused = await api("GET", `/api/computer-audit?botId=${bot.id}`, undefined, 403, { "x-omb-space": work.id });
    assert.equal(refused.code, "space_isolation");
    evidence.http = { evidencePath, rows: after.length };
  } finally {
    writeFileSync(evidencePath, JSON.stringify(http, null, 2));
    await fixture.close(); await removeTempDir(dir);
  }
  return evidence;
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  console.log(JSON.stringify(await verifyComputerAudit(), null, 2));
}
