// "Always allow everything" on a waiting approval card: under the operator's
// opt-in (OMB_OPERATOR_FULL_ACCESS=1) the paired web UI grants the asking bot
// Full access on its default and every thread while its turn is still
// running, and the card that prompted it is answered. Runs the real server
// against the fake ACP CLI, which asks permission to run `echo hi`.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

let child: ChildProcess;
let home: string;
let stderr = "";

const api = async (method: string, path: string, body?: unknown, origin?: string): Promise<{ status: number; body: any }> => {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  if (origin) headers.origin = origin;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

const botById = async (id: string) =>
  (await api("GET", "/api/bots")).body.bots.find((b: { id: string }) => b.id === id);

async function until<T>(read: () => Promise<T | null | undefined | false>, what: string, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

posixOnly("allow everything from an approval card", () => {
  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-allow-everything-e2e-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    writeFileSync(join(home, ".openmausbot", "config.json"), JSON.stringify({
      instances: {
        grok: {
          driver: "grokAgent",
          environment: { FAKE_ACP_MODE: "permission" },
          config: { cli: FAKE_CLI, fullAuto: false },
        },
      },
    }));
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home,
        USERPROFILE: home,
        OMB_PORT: String(PORT),
        OMB_WEBHOOK_PORT: String(PORT + 1),
        OMB_OPERATOR_FULL_ACCESS: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    await until(async () => (await fetch(`${BASE}/api/health`).catch(() => null))?.ok, "the server");
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("grants Full on every thread mid-turn and answers the waiting card", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { name: "Asker", modelSelection: { instanceId: "grok", model: "fake-model" } })).status).toBe(200);
    const sibling = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Sibling" })).body.task;
    expect(sibling.approvalMode).toBe("ask");

    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "run it" })).status).toBe(202);
    const card = await until(async () => (await botById(bot.id))?.messages?.find(
      (m: { kind: string; card?: { requestId?: string; answered?: string } }) => m.kind === "options" && m.card?.requestId && !m.card.answered,
    ), "the approval card");

    // The ordinary bot PATCH still refuses a level change on a busy bot.
    expect((await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "full", confirmFullAccess: true })).status).toBe(409);

    const body = { threadId: bot.threadId, confirmFullAccess: true };
    // A bot curling the loopback API (no browser origin) cannot grant itself.
    expect((await api("POST", `/api/bots/${bot.id}/allow-everything`, body)).status).toBe(403);
    // The warning must have been acknowledged.
    expect((await api("POST", `/api/bots/${bot.id}/allow-everything`, { threadId: bot.threadId }, BASE)).status).toBe(400);

    const granted = await api("POST", `/api/bots/${bot.id}/allow-everything`, body, BASE);
    expect(granted.status).toBe(200);
    expect(granted.body).toMatchObject({ ok: true, answered: 1, bot: { approvalMode: "full" } });

    const after = await until(async () => {
      const current = await botById(bot.id);
      return !current.busy && current.messages.some((m: { text?: string }) => m.text?.includes("handled the permission decision")) && current;
    }, "the turn to finish after the allow");
    expect(after.messages.find((m: { id: string }) => m.id === card.id)?.card?.answered).toBeTruthy();
    // The bot default and every thread, the idle sibling included.
    expect(after.approvalMode).toBe("full");
    const modes = after.tasks.map((task: { threadId: string; approvalMode: string }) => [task.threadId, task.approvalMode]);
    expect(modes).toContainEqual([sibling.threadId, "full"]);
    expect(modes).toContainEqual([bot.threadId, "full"]);
  }, 60_000);

  type CardMessage = { id: string; kind: string; card: { requestId: string; answered?: string } };
  const openCard = (bot: { messages?: CardMessage[] }): CardMessage | undefined =>
    bot?.messages?.find((m) => m.kind === "options" && m.card?.requestId && !m.card.answered);

  it("lands a level chosen mid-turn when the turn finishes", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { name: "Later", modelSelection: { instanceId: "grok", model: "fake-model" } })).status).toBe(200);
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "run it" })).status).toBe(202);
    const card = await until(async () => openCard(await botById(bot.id)), "the approval card");

    const path = `/api/bots/${bot.id}/approval-mode-when-busy`;
    expect((await api("POST", path, { approvalMode: "auto", whenBusy: "next-turn" })).status).toBe(403);
    expect((await api("POST", path, { approvalMode: "full", whenBusy: "next-turn" }, BASE)).status).toBe(400);
    const scheduled = await api("POST", path, { approvalMode: "auto", whenBusy: "next-turn" }, BASE);
    expect(scheduled.status).toBe(200);
    expect(scheduled.body).toMatchObject({ pending: true, bot: { pendingApprovalMode: "auto" } });
    expect(scheduled.body.bot.approvalMode ?? "ask").toBe("ask");

    expect((await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: card.card.requestId, behavior: "allow" }, BASE)).status).toBe(200);
    const after = await until(async () => {
      const current = await botById(bot.id);
      return !current.busy && current.approvalMode === "auto" && current;
    }, "the pending level to land");
    expect(after.pendingApprovalMode).toBeUndefined();
    expect(after.tasks.find((task: { threadId: string }) => task.threadId === bot.threadId).approvalMode).toBe("auto");
  }, 60_000);

  it("keeps Full when a level was queued first, and keeping the current level needs no warning", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { name: "Queued", modelSelection: { instanceId: "grok", model: "fake-model" } })).status).toBe(200);
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "run it" })).status).toBe(202);
    await until(async () => openCard(await botById(bot.id)), "the approval card");

    const path = `/api/bots/${bot.id}/approval-mode-when-busy`;
    expect((await api("POST", path, { approvalMode: "auto", whenBusy: "next-turn" }, BASE)).body).toMatchObject({ pending: true });
    const granted = await api("POST", `/api/bots/${bot.id}/allow-everything`, { threadId: bot.threadId, confirmFullAccess: true }, BASE);
    expect(granted.status).toBe(200);
    expect(granted.body.bot.pendingApprovalMode).toBeUndefined();

    // Already Full: choosing Full again withdraws nothing and grants nothing.
    const keep = await api("POST", path, { approvalMode: "full", whenBusy: "next-turn" }, BASE);
    expect(keep.status).toBe(200);
    expect(keep.body).toMatchObject({ pending: false });

    const after = await until(async () => {
      const current = await botById(bot.id);
      return !current.busy && current;
    }, "the turn to finish");
    expect(after.approvalMode).toBe("full");
  }, 60_000);

  it("stops the running turn, switches the level, and continues it", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { name: "Restart", modelSelection: { instanceId: "grok", model: "fake-model" } })).status).toBe(200);
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "run it" })).status).toBe(202);
    const first = await until(async () => openCard(await botById(bot.id)), "the approval card");

    const restarted = await api("POST", `/api/bots/${bot.id}/approval-mode-when-busy`,
      { approvalMode: "full", whenBusy: "restart", confirmFullAccess: true, applyToAllThreads: true }, BASE);
    expect(restarted.status).toBe(200);

    // The continued turn runs under Full: its permission ask is answered by
    // the harness, so it finishes without a new card.
    const after = await until(async () => {
      const current = await botById(bot.id);
      return !current.busy && current.messages.some((m: { role: string; text?: string }) =>
        m.role === "user" && m.text?.startsWith("Continue where you left off")) &&
        current.messages.filter((m: { text?: string }) => m.text?.includes("handled the permission decision")).length >= 1 && current;
    }, "the continued turn under Full");
    expect(after.approvalMode).toBe("full");
    expect(after.pendingApprovalMode).toBeUndefined();
    expect(openCard(after)).toBeUndefined();
    expect(after.messages.find((m: { id: string }) => m.id === first.id)?.card?.answered).toBeTruthy();
  }, 60_000);
});

