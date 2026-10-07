import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment, type VerificationServer } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}`);
}
function client(fixture: VerificationServer) {
  return async (path: string, method = "GET", body?: unknown): Promise<any> => {
    const response = await fetch(`${fixture.info.url}/api${path}`, { method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(result)}`);
    return result;
  };
}
const envelope = (status: string) => `<openmaus-goal>${JSON.stringify({ status, detail: status === "completed" ? "Verified the deliverable" : "Draft prepared",
  ...(status === "continue" ? { next: "self", instruction: "Verify the draft" } : {}) })}</openmaus-goal>`;

describe("chat goals and next-run model selection", () => {
  it("runs a durable goal through two turns, strips private protocol, and deduplicates its command", async () => {
    const temp = mkdtempSync(join(tmpdir(), "goal-replies-"));
    const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_TOOL_CALLS: "[]",
      FAKE_CLAUDE_REPLIES: JSON.stringify([`Draft ready.\n${envelope("continue")}`, `Verified result.\n${envelope("completed")}`]),
      FAKE_CLAUDE_REPLY_STATE: join(temp, "reply-state") });
    try {
      const api = client(fixture);
      const { bot } = await api("/bots", "POST", { name: "Goal fixture", computer: "off" });
      const read = async () => (await api("/bots")).bots.find((row: any) => row.id === bot.id);
      const body = { threadId: bot.threadId, text: "/goal prepare and verify a draft", sendId: "goal-start-test-0001" };
      await api(`/bots/${bot.id}/messages`, "POST", body);
      await until(async () => (await read()).tasks[0].goal?.status === "completed", "goal completion");
      const completed = await read();
      expect(completed.tasks[0].goal).toMatchObject({ status: "completed", turns: 2, objective: "prepare and verify a draft" });
      await api(`/bots/${bot.id}/messages`, "POST", body);
      const messages = (await read()).messages;
      expect(messages.filter((m: any) => m.sendId === body.sendId)).toHaveLength(1);
      expect(messages.some((m: any) => m.text?.includes("Verified result."))).toBe(true);
      expect(messages.some((m: any) => m.text?.includes("openmaus-goal"))).toBe(false);
      expect(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).systemPrompt).toContain("persistent goal");
    } finally { await fixture.close(); rmSync(temp, { recursive: true, force: true }); }
  }, 90_000);

  it("persists pause through a server restart, resumes, and stops only the selected chat goal", async () => {
    const env = { ...process.env, FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_TOOL_CALLS: "[]" };
    const fixture = await launchVerificationServer(env);
    let restarted: ChildProcess | undefined;
    try {
      const api = client(fixture);
      const { bot } = await api("/bots", "POST", { name: "Paused goal fixture", computer: "off" });
      const read = async () => (await api("/bots")).bots.find((row: any) => row.id === bot.id);
      const command = (text: string) => api(`/bots/${bot.id}/messages`, "POST", { threadId: bot.threadId, text });
      await command("/goal finish the project");
      await until(async () => (await read()).busy, "goal working");
      await command("/goal pause");
      await until(async () => !(await read()).busy, "goal paused");
      expect((await read()).tasks[0].goal.status).toBe("paused");
      fixture.child.kill("SIGTERM"); await waitForExit(fixture.child);
      restarted = spawn(process.execPath, fixture.child.spawnargs.slice(1), {
        cwd: process.cwd(), env: verificationServerEnvironment(env, fixture.info.dataDir, Number(new URL(fixture.info.url).port)), stdio: "ignore",
      });
      await until(async () => { try { return (await read()).tasks[0].goal.status === "paused"; } catch { return false; } }, "restart persistence");
      expect((await read()).busy).toBe(false);
      await command("/goal resume");
      await until(async () => (await read()).busy, "goal resumed");
      const turnsBeforeRestart = (await read()).tasks[0].goal.turns;
      restarted.kill("SIGTERM"); await waitForExit(restarted);
      restarted = spawn(process.execPath, fixture.child.spawnargs.slice(1), {
        cwd: process.cwd(), env: verificationServerEnvironment(env, fixture.info.dataDir, Number(new URL(fixture.info.url).port)), stdio: "ignore",
      });
      await until(async () => { try { const b = await read(); return b.busy && b.tasks[0].goal.turns > turnsBeforeRestart; } catch { return false; } }, "active goal resumes after restart");
      await command("/goal stop");
      await until(async () => !(await read()).busy, "goal stopped");
      expect((await read()).tasks[0].goal.status).toBe("stopped");
      await command("/goal status");
      expect((await read()).tasks[0].goal.status).toBe("stopped");
    } finally {
      if (restarted) { restarted.kill("SIGTERM"); await waitForExit(restarted); }
      await fixture.close();
    }
  }, 90_000);

  it("keeps current settings until the next run, then applies a new selection immediately when steered", async () => {
    const temp = mkdtempSync(join(tmpdir(), "model-next-run-"));
    const gate = join(temp, "finish");
    const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_FINISH_GATE: gate }, undefined, undefined, undefined, undefined, undefined, ["codex"]);
    try {
      const api = client(fixture);
      const { bot } = await api("/bots", "POST", { name: "Model fixture", computer: "off" });
      const read = async () => (await api("/bots")).bots.find((row: any) => row.id === bot.id);
      const dump = () => JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
      const send = (text: string) => api(`/bots/${bot.id}/messages`, "POST", { threadId: bot.threadId, text });
      await send("First run");
      await until(() => existsSync(fixture.fixtureDumpPath), "initial dispatch");
      const first = dump();
      const selection = { instanceId: "claude", model: "claude-opus-5.5", effort: "high" };
      await api(`/bots/${bot.id}/tasks/${bot.threadId}`, "PATCH", { modelSelection: selection, updateBotDefault: true });
      expect((await read()).busy).toBe(true);
      expect(dump().argv).toEqual(first.argv);
      writeFileSync(gate, "finish");
      await until(async () => !(await read()).busy, "natural finish");
      rmSync(gate);
      await send("Second run");
      await until(() => dump().pid !== first.pid, "next model dispatch");
      const second = dump();
      expect(second.argv).toContain("claude-opus-5.5");
      expect(second.argv[second.argv.indexOf("--effort") + 1]).toBe("high");
      await api(`/bots/${bot.id}/tasks/${bot.threadId}`, "PATCH", { modelSelection: { ...selection, effort: "low" } });
      await send("Change direction now");
      await until(() => dump().pid !== second.pid, "steering applies pending effort");
      expect(dump().argv[dump().argv.indexOf("--effort") + 1]).toBe("low");
      expect((await read()).messages.filter((m: any) => m.text === "Change direction now")).toHaveLength(1);
      await api(`/bots/${bot.id}/tasks/${bot.threadId}`, "PATCH", { modelSelection: { instanceId: "codex", model: "gpt-fake-default", effort: "medium" } });
      await send("Use the other provider now");
      await until(async () => !(await read()).busy, "cross-provider steering settles");
      expect((await read()).tasks[0].modelSelection).toMatchObject({ instanceId: "codex", effort: "medium" });
      expect((await read()).messages.filter((m: any) => m.text === "Use the other provider now")).toHaveLength(1);
    } finally { await fixture.close(); rmSync(temp, { recursive: true, force: true }); }
  }, 90_000);
});
