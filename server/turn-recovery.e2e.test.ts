import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment, type VerificationServer } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

async function until(check: () => boolean | Promise<boolean>) {
  await expect.poll(async () => { try { return await check(); } catch { return false; } }, { timeout: 30_000, interval: 100 }).toBe(true);
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
async function installCrashFixture(fixture: VerificationServer) {
  const wrapper = join(fixture.info.dataDir, "crash-fixture.mjs");
  writeFileSync(wrapper, '#!/usr/bin/env node\nprocess.stdin.on("end", () => process.exit(0));\nawait import(' + JSON.stringify(pathToFileURL(fileURLToPath(new URL("./testing/fake-claude-cli.ts", import.meta.url))).href) + ');\n', { mode: 0o700 });
  await client(fixture)("/instances/claude", "PATCH", { cli: wrapper });
}
function journal(fixture: VerificationServer): any[] {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try { return db.prepare("SELECT payload FROM running_turns").all().map(row => JSON.parse(String(row.payload))); }
  finally { db.close(); }
}
function restart(fixture: VerificationServer, env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, fixture.child.spawnargs.slice(1), {
    cwd: process.cwd(), env: verificationServerEnvironment(env, fixture.info.dataDir, Number(new URL(fixture.info.url).port)), stdio: "ignore",
  });
}

it.each(["SIGKILL", "SIGTERM"] as const)("continues an interrupted bot after %s without duplicating its request, and never revives completed or stopped turns", async signal => {
  const env = { ...process.env, FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_TOOL_CALLS: "[]" };
  const fixture = await launchVerificationServer(env);
  let child: ChildProcess | undefined;
  try {
    const api = client(fixture);
    await installCrashFixture(fixture);
    const { bot } = await api("/bots", "POST", { name: "Recovery fixture", computer: "off" });
    await api(`/bots/${bot.id}/messages`, "POST", { threadId: bot.threadId, text: "Build the requested artifact", sendId: "restart-original-request" });
    await until(() => existsSync(fixture.fixtureDumpPath));
    expect(journal(fixture)).toMatchObject([{ threadId: bot.threadId, kind: "bot" }]);
    await waitForExit(fixture.child, { signal });
    expect(journal(fixture)).toHaveLength(1);
    rmSync(fixture.fixtureDumpPath);
    child = restart(fixture, env);
    await until(() => existsSync(fixture.fixtureDumpPath));
    expect(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).systemPrompt).toContain("LEGION's service went down");
    await waitForExit(child, { signal });
    expect(journal(fixture)).toHaveLength(1);
    rmSync(fixture.fixtureDumpPath);
    child = restart(fixture, { ...env, FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_REPLIES: JSON.stringify(["Verified the existing artifact and finished the remaining step."]) });
    await until(async () => (await api("/bots")).bots.find((b: any) => b.id === bot.id)?.messages.some((m: any) => m.text?.includes("Verified the existing artifact")));
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    expect(dump.systemPrompt).toContain("LEGION's service went down");
    expect(dump.systemPrompt).toContain("Inspect current state before repeating");
    const read = async () => (await api("/bots")).bots.find((b: any) => b.id === bot.id);
    expect((await read()).messages.filter((m: any) => m.role === "user")).toHaveLength(1);
    await until(() => journal(fixture).length === 0);
    await waitForExit(child, { signal: "SIGTERM" });
    rmSync(fixture.fixtureDumpPath);
    child = restart(fixture, env);
    await until(async () => Boolean(await read()));
    expect(existsSync(fixture.fixtureDumpPath)).toBe(false);
    await api(`/bots/${bot.id}/messages`, "POST", { threadId: bot.threadId, text: "Work that I will explicitly stop" });
    await until(() => existsSync(fixture.fixtureDumpPath));
    await api(`/bots/${bot.id}/interrupt`, "POST", { threadId: bot.threadId });
    await until(() => journal(fixture).length === 0);
    await waitForExit(child, { signal: "SIGTERM" });
    rmSync(fixture.fixtureDumpPath);
    child = restart(fixture, env);
    await until(async () => Boolean(await read()));
    expect((await read()).busy).toBe(false);
    expect(journal(fixture)).toHaveLength(0);
    expect(existsSync(fixture.fixtureDumpPath)).toBe(false);
  } finally { await waitForExit(child, { signal: "SIGTERM" }); await fixture.close(); }
}, 120_000);

it.each(["SIGKILL", "SIGTERM"] as const)("recovers room chat, room goals and routine runs with their original identities after %s", async signal => {
  const env = { ...process.env, FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_TOOL_CALLS: "[]" };
  const fixture = await launchVerificationServer(env);
  let child: ChildProcess | undefined;
  try {
    const api = client(fixture);
    await installCrashFixture(fixture);
    const createBot = async (name: string) => (await api("/bots", "POST", { name, computer: "off" })).bot;
    const lead = await createBot("Room lead"), worker = await createBot("Goal lead"), scheduled = await createBot("Routine worker"), scheduledLead = await createBot("Scheduled room lead");
    const room = async (bot: any, name: string) => (await api("/groups", "POST", { name, memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } })).group;
    const chat = await room(lead, "Chat recovery"), goal = await room(worker, "Goal recovery");
    await api(`/groups/${chat.id}/messages`, "POST", { text: "Finish the room task", mode: "chat" });
    await api(`/groups/${goal.id}/messages`, "POST", { text: "Finish and verify the room goal", mode: "goal" });
    const { routine } = await api("/routines", "POST", { name: "Recovery routine", botId: scheduled.id, prompt: "Finish the scheduled task", enabled: false, schedule: { type: "daily", time: "09:00", weekdays: [1] } });
    const { run } = await api(`/routines/${routine.id}/run`, "POST");
    const scheduledRoom = await room(scheduledLead, "Scheduled recovery room");
    const scheduledGoal = await api("/routines", "POST", { name: "Scheduled room recovery", botId: scheduledLead.id,
      target: "room-goal", groupId: scheduledRoom.id, runOn: "maus", prompt: "Verify the scheduled room deliverable",
      enabled: false, schedule: { type: "daily", time: "09:00", weekdays: [1] } });
    const goalRun = (await api(`/routines/${scheduledGoal.routine.id}/run`, "POST")).run;
    await until(() => journal(fixture).length === 4);
    const before = journal(fixture);
    expect(before.find(row => row.routineRunId === goalRun.id)).toBeTruthy();
    expect(before.find(row => row.routineRunId === run.id)).toBeTruthy();
    await waitForExit(fixture.child, { signal });
    child = restart(fixture, { ...env, FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_REPLIES: JSON.stringify(['Work verified.\n<openmaus-goal>{"status":"completed","detail":"Verified the existing deliverable"}</openmaus-goal>']) });
    await until(() => journal(fixture).length === 0);
    const { runs } = await api("/routines");
    expect(runs.find((row: any) => row.id === run.id)).toMatchObject({ id: run.id, status: "completed" });
    expect(runs.filter((row: any) => row.routineId === routine.id)).toHaveLength(1);
    expect(runs.find((row: any) => row.id === goalRun.id)).toMatchObject({ status: "completed", goalStatus: "completed" });
    expect(runs.filter((row: any) => row.routineId === scheduledGoal.routine.id)).toHaveLength(1);
    for (const group of [chat, goal]) {
      const { messages } = await api(`/threads/${group.threadId}/messages`);
      expect(messages.filter((m: any) => m.role === "user")).toHaveLength(1);
      expect(messages.some((m: any) => m.tool?.name?.includes("LEGION restarted"))).toBe(true);
      if (group.id === goal.id) {
        expect(messages.filter((m: any) => m.kind === "goal.run")).toHaveLength(1);
        expect(messages.find((m: any) => m.kind === "goal.run").goalRun.status).toBe("completed");
      }
    }
  } finally { await waitForExit(child, { signal: "SIGTERM" }); await fixture.close(); }
}, 120_000);
