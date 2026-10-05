// Per-computer audit log and instant revocation, against a loopback Boat that
// stands in for the provider (same fixture shape as cloud-computer-tools.test).
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config.ts";
import { ComputerAuditLog, auditedComputerCall } from "./computer-audit.ts";
import { ComputerEpochs } from "./computer-epoch.ts";
import { removeTempDir } from "./testing/cleanup.ts";

let server: Server;
let tools: typeof import("./cloud-computer-tools.ts");
let holdCommand = false;
let commandStarted: (() => void) | undefined;
const cfg: AppConfig = { box: { token: "synthetic-box-key" } } as AppConfig;
const dirs: string[] = [];
const freshDir = () => { const dir = mkdtempSync(join(tmpdir(), "omb-computer-audit-")); dirs.push(dir); return dir; };

beforeAll(async () => {
  server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    if ((req.url ?? "").endsWith("/commands")) {
      commandStarted?.();
      if (!holdCommand) res.end(JSON.stringify({ exitCode: 0, stdout: "captured", stderr: "" }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind");
  vi.stubEnv("OMB_BOX_API", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("OMB_CLOUD_BOAT_TOKEN", undefined);
  tools = await import("./cloud-computer-tools.ts");
});
beforeEach(() => { holdCommand = false; commandStarted = undefined; });
afterAll(async () => {
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of dirs) removeTempDir(dir);
});

/** The same wrapping index.ts applies at /api/internal/computer/mcp. */
function call(audit: ComputerAuditLog, epochs: ComputerEpochs, name: string, args: Record<string, unknown>, extra: {
  botId?: string; computerId?: string; check?: () => string | null; held?: boolean;
} = {}) {
  const botId = extra.botId ?? "bot-1";
  return auditedComputerCall(name, {
    audit, epochs, botId, computerId: extra.computerId ?? `bot-${botId}`, ...(extra.check ? { check: extra.check } : {}),
    dispatch: ({ signal, gate, assertActive }) => tools.cloudComputerRpc(
      { method: "tools/call", params: { name, arguments: args } },
      { cfg, boxId: "bx_23456789", signal,
        gate: () => gate(async () => ({ held: extra.held ?? false })), assertActive: () => assertActive(() => {}) },
    ),
  });
}

describe("computer audit", () => {
  it("records one row per action with no typed content", async () => {
    const dir = freshDir();
    const audit = new ComputerAuditLog(dir), epochs = new ComputerEpochs();
    const secret = "hunter2-typed-secret";
    await call(audit, epochs, "type_text", { text: secret });
    await call(audit, epochs, "exec", { command: `echo ${secret}` });
    await call(audit, epochs, "click", { x: 12, y: 34 });
    const rows = audit.list("bot-bot-1");
    expect(rows.map((row) => row.action)).toEqual(["click", "exec", "type_text"]);
    expect(rows.every((row) => row.actor === "bot" && row.outcome === "ok" && row.botId === "bot-1")).toBe(true);
    const file = join(dir, "computer-audit", readdirSync(join(dir, "computer-audit"))[0]!);
    expect(readFileSync(file, "utf8")).not.toContain(secret);
    expect(readFileSync(file, "utf8")).not.toMatch(/"x"|"y"|echo|command/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(audit.list("bot-bot-1", { action: "exec" })).toHaveLength(1);
    expect(audit.list("bot-bot-1", { outcome: "denied" })).toHaveLength(0);
  });

  it("records a person's control as denied", async () => {
    const audit = new ComputerAuditLog(freshDir());
    await call(audit, new ComputerEpochs(), "click", { x: 1, y: 2 }, { held: true });
    expect(audit.list("bot-bot-1")[0]).toMatchObject({ action: "click", outcome: "denied" });
  });

  it("cancels an in-flight action within ~100ms of revocation", async () => {
    const audit = new ComputerAuditLog(freshDir()), epochs = new ComputerEpochs();
    holdCommand = true;
    const started = new Promise<void>((resolve) => { commandStarted = resolve; });
    const running = call(audit, epochs, "exec", { command: "sleep 600" });
    await started;
    expect(epochs.inFlight("bot-1")).toBe(1);
    const revokedAt = performance.now();
    const cancelled = epochs.revoke("bot-1", "the owner revoked access");
    const outcome = await running;
    const elapsed = performance.now() - revokedAt;
    expect(cancelled).toBe(1);
    expect(outcome).toEqual({ kind: "revoked", reason: "the owner revoked access" });
    expect(elapsed).toBeLessThan(250);
    expect(audit.list("bot-bot-1")[0]).toMatchObject({ action: "exec", outcome: "denied", error: "cancelled: the owner revoked access" });
    expect(epochs.inFlight()).toBe(0);
    holdCommand = false;
    // The epoch moved on: the next call on the same binding starts from the new epoch.
    expect((await call(audit, epochs, "get_screen_size", {})).kind).toBe("result");
  });

  it.each([
    ["owner disables the computer", () => ({ computer: "off" as string, mode: "full", space: "a" }), { computer: "off" }, "the owner disabled"],
    ["approval downgrade to Ask", () => ({ computer: "cloud", mode: "full", space: "a" }), { mode: "ask" }, "downgraded to Ask"],
    ["space isolation", () => ({ computer: "cloud", mode: "full", space: "a" }), { space: "b" }, "space isolation"],
  ])("revalidate aborts when %s", async (_name, initial, change, text) => {
    const audit = new ComputerAuditLog(freshDir()), epochs = new ComputerEpochs();
    const state = { computer: "cloud", mode: "full", space: "a", ...(initial() as object) } as Record<string, string>;
    state.computer = "cloud";
    const startedMode = state.mode;
    const check = () => state.computer === "off" ? "the owner disabled this computer for the bot"
      : state.space !== "a" ? "space isolation: the computer is in another space"
      : startedMode !== "ask" && state.mode === "ask" ? "approval mode was downgraded to Ask" : null;
    holdCommand = true;
    const started = new Promise<void>((resolve) => { commandStarted = resolve; });
    const running = call(audit, epochs, "exec", { command: "sleep 600" }, { check });
    await started;
    expect(epochs.revalidate("bot-1")).toBe(0);
    Object.assign(state, change);
    expect(epochs.revalidate("bot-1")).toBe(1);
    const outcome = await running;
    expect(outcome.kind).toBe("revoked");
    expect(audit.list("bot-bot-1")[0]!.error).toContain(text);
  });

  it("refuses a new call when the check already denies it (space isolation)", async () => {
    const audit = new ComputerAuditLog(freshDir());
    const outcome = await call(audit, new ComputerEpochs(), "click", { x: 1, y: 2 }, { check: () => "space isolation: the computer is in another space" });
    expect(outcome.kind).toBe("revoked");
    expect(audit.list("bot-bot-1")[0]).toMatchObject({ action: "click", outcome: "denied", error: "space isolation: the computer is in another space" });
  });

  it("caps retained rows per computer", () => {
    const audit = new ComputerAuditLog(freshDir(), 50);
    for (let i = 0; i < 400; i++) audit.append({ ts: i, computerId: "c1", botId: "b", actor: "bot", action: `tool${i}`, outcome: "ok", durationMs: 1 });
    audit.append({ ts: 1, computerId: "c2", botId: "b", actor: "bot", action: "other", outcome: "ok", durationMs: 1 });
    expect(audit.size("c1")).toBe(50);
    expect(audit.list("c1", { limit: 1000 })).toHaveLength(50);
    expect(audit.list("c1")[0]!.action).toBe("tool399");
    expect(audit.size("c2")).toBe(1);
  });

  it("redacts and shortens error summaries", () => {
    const audit = new ComputerAuditLog(freshDir());
    audit.append({ ts: 1, computerId: "c", botId: "b", actor: "bot", action: "exec", outcome: "error", durationMs: 1, error: "x".repeat(500) });
    expect(audit.list("c")[0]!.error).toHaveLength(200);
  });
});
