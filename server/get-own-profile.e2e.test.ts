// Real server + injected MCP tools; only the provider's planning is scripted.
// Proves get_own_profile returns a confirmed propose_profile soul in the same
// turn, with no restart, and never another bot's profile.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("get_own_profile reads back a just-applied soul in the same turn and only for the caller", async () => {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir, logPath } = fixture.info;
  const planPath = join(dataDir, "room-plan.json");
  const plans: Record<string, { turns: any[] }> = {};
  let restarted: ChildProcess | undefined;
  const providerTurns = (): any[] => existsSync(`${planPath}.evidence.jsonl`)
    ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const cli = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const step = (tool: string, args: unknown) => ({ tool, arguments: args, expectError: false });
  const toolText = (turn: any, index: number): string =>
    turn.evidence.filter((entry: any) => entry.step)[index].response.result.content[0].text;
  const run = async (bot: any, text: string, steps: any[]) => {
    const before = providerTurns().length;
    (plans[bot.id] ??= { turns: [] }).turns.push({ steps, reply: `done ${before}` });
    writeFileSync(planPath, JSON.stringify(plans));
    await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", text);
    await expect.poll(() => providerTurns().length, { timeout: 25_000 }).toBe(before + 1);
    expect((await cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "25")).status).toBe("settled");
    return providerTurns()[before];
  };
  const restart = async () => {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TZ"].includes(key.toUpperCase()) && value) env[key.toUpperCase()] = value;
    }
    Object.assign(env, {
      HOME: dataDir, USERPROFILE: dataDir, OMB_DATA_DIR: dataDir,
      APPDATA: join(dataDir, "AppData", "Roaming"), LOCALAPPDATA: join(dataDir, "AppData", "Local"),
      XDG_CONFIG_HOME: join(dataDir, ".config"), XDG_CACHE_HOME: join(dataDir, ".cache"),
      XDG_DATA_HOME: join(dataDir, ".local", "share"), HERMES_HOME: join(dataDir, ".hermes"),
      TEMP: join(dataDir, "tmp"), TMP: join(dataDir, "tmp"), TMPDIR: join(dataDir, "tmp"),
      OMB_PORT: new URL(url).port, OMB_WEBHOOK_PORT: String(Number(new URL(url).port) + 1), PATH: dirname(process.execPath),
      FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_DUMP: fixture.fixtureDumpPath,
    });
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env, stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      expect(restarted?.exitCode, `see ${logPath}`).toBeNull();
      try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) })).ok; }
      catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
  };
  try {
    const kiwi = (await cli("new-bot", "--name", "Kiwi", "--section", "Ops")).bot;
    const other = (await cli("new-bot", "--name", "Other", "--section", "Ops")).bot;
    // Fixture-only persisted grant so propose_profile applies without a card.
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const saved = JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8"));
    const savedKiwi = saved.find((bot: any) => bot.id === kiwi.id);
    savedKiwi.approvalMode = "full"; savedKiwi.autoApprove = false; savedKiwi.soul = "SOUL-BEFORE: original rules.";
    for (const task of savedKiwi.tasks) { task.approvalMode = "full"; task.autoApprove = false; }
    saved.find((bot: any) => bot.id === other.id).soul = "OTHER-SOUL: must never leak.";
    writeFileSync(join(dataDir, "bots.json"), JSON.stringify(saved, null, 2));
    await restart();

    const newSoul = "SOUL-AFTER: distinguishable replacement rules.";
    const turn = await run(kiwi, "Read, change, and re-read my own soul.", [
      step("get_own_profile", {}),
      step("propose_profile", { soul: newSoul, reason: "Verify live self-profile read" }),
      step("get_own_profile", {}),
    ]);
    const before = JSON.parse(toolText(turn, 0));
    const after = JSON.parse(toolText(turn, 2));
    console.log("BEFORE", JSON.stringify(before), "\nAFTER", JSON.stringify(after));
    expect(before).toMatchObject({ name: "Kiwi", soul: "SOUL-BEFORE: original rules." });
    expect(Object.keys(before).sort()).toEqual(
      ["cwd", "description", "modelSelection", "name", "notifications", "soul", "speakReplies", "title"]);
    expect(after.soul).toBe(newSoul);
    expect(after).toMatchObject({ name: "Kiwi", modelSelection: before.modelSelection });

    // Another bot reads only itself, whatever the first bot just wrote.
    const otherTurn = await run(other, "Read my own profile.", [step("get_own_profile", {})]);
    expect(JSON.parse(toolText(otherTurn, 0))).toMatchObject({ name: "Other", soul: "OTHER-SOUL: must never leak." });
    expect(readFileSync(logPath, "utf8")).not.toMatch(/ReferenceError|Unexpected extra fixture turn/);
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 120_000);
