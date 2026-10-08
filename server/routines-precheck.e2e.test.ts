import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("scheduled empty checks stay out of chat while failed checks and manual intent dispatch through the real server", async () => {
  const fixture = await launchVerificationServer();
  const api = async (method: string, path: string, body?: unknown, expected = 200) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, JSON.stringify(value)).toBe(expected);
    return value;
  };
  try {
    const { bot } = await runControlOmb(["new-bot", "--name", "Pre-check fixture", "--url", fixture.info.url]) as any;
    const savedBot = (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === bot.id);
    const destination = savedBot.threadId;
    const marker = join(fixture.info.dataDir, "empty-check-executed");
    const emptyScript = join(fixture.info.dataDir, "empty-check.mjs");
    writeFileSync(emptyScript, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'checked');console.log('{"items":[]}');`);
    const { routine } = await api("POST", "/api/routines", {
      name: "Quiet empty check", prompt: "Review new mail", botId: bot.id,
      schedule: { type: "once", at: Date.now() }, resultsThreadId: destination,
      preCheck: { command: process.execPath, args: [emptyScript], timeoutMs: 1000 },
    }, 201);
    expect(routine.preCheck.command).toBe(process.execPath);
    await expect.poll(async () => (await api("GET", "/api/routines")).runs.find((run: any) => run.routineId === routine.id)?.status, { timeout: 15_000 }).toBe("skipped");
    expect(readFileSync(marker, "utf8")).toBe("checked");
    expect(existsSync(fixture.fixtureDumpPath)).toBe(false);
    const messages = async () => (await api("GET", `/api/threads/${destination}/messages?limit=100`)).messages;
    expect((await messages()).filter((message: any) => message.kind === "routine.run")).toEqual([]);
    // Source sync must stay quiet even when the skipped receipt is viewed.
    const skipped = (await api("GET", "/api/routines")).runs.find((run: any) => run.routineId === routine.id);
    await api("POST", `/api/routine-runs/${skipped.id}/seen`);
    expect((await messages()).filter((message: any) => message.kind === "routine.run")).toEqual([]);
    const { run: manual } = await api("POST", `/api/routines/${routine.id}/run`, undefined, 201);
    await expect.poll(async () => (await api("GET", "/api/routines")).runs.find((run: any) => run.id === manual.id)?.status, { timeout: 15_000 }).toBe("completed");
    expect((await messages()).filter((message: any) => message.kind === "routine.run")).toHaveLength(1);
    const { routine: failing } = await api("POST", "/api/routines", {
      name: "Failed check wakes", prompt: "Review new mail", botId: bot.id,
      schedule: { type: "once", at: Date.now() }, resultsThreadId: destination,
      preCheck: { command: "/no/such/precheck" },
    }, 201);
    await expect.poll(async () => (await api("GET", "/api/routines")).runs.find((run: any) => run.routineId === failing.id)?.status, { timeout: 15_000 }).toBe("completed");
    const failedCheckRun = (await api("GET", "/api/routines")).runs.find((run: any) => run.routineId === failing.id);
    expect(failedCheckRun.preCheckResult).toMatchObject({ state: "fallback", reason: "spawn_error" });
    expect((await messages()).filter((message: any) => message.kind === "routine.run")).toHaveLength(2);
    expect((await api("GET", "/api/config")).decider.jobs.routineWake).toBe(false);
  } finally { await fixture.close(); }
}, 60_000);
