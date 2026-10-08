import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  activeScriptPlan, escalationPrompt, loadExecutionPlan, parseReview, reviewPrompt, runRoutineScript, scriptReport, sha256,
} from "./routine-execution.ts";
import { RoutineManager, type RoutineManagerOptions } from "./routines.ts";

const dirs: string[] = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "omb-routine-exec-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const PROMPT = "Check https://status.example.com/api and tell me if anything is down.";

describe("the reviewer's verdict", () => {
  it("proposes a script, fenced or not, bound to the instructions and the script", () => {
    const reply = "Sure:\n```json\n" + JSON.stringify({ mode: "script", rationale: "Plain HTTP check.", script: "print('ok')" }) + "\n```";
    const plan = parseReview(reply, PROMPT, "sonnet-5", 1_000)!;
    expect(plan).toMatchObject({ mode: "script", status: "proposed", rationale: "Plain HTTP check.", reviewer: "sonnet-5", reviewedAt: 1_000 });
    expect(plan.script).toBe("print('ok')\n");
    expect(plan.promptHash).toBe(sha256(PROMPT));
    expect(plan.scriptHash).toBe(sha256(plan.script!));
  });

  it("needs nothing approved when the bot should keep running", () => {
    expect(parseReview('{"mode":"llm","rationale":"Needs judgement."}', PROMPT, "m", 1)).toMatchObject({ mode: "llm", status: "approved" });
  });

  it("refuses a verdict that does not check out", () => {
    expect(parseReview("no json here", PROMPT, "m", 1)).toBeNull();
    expect(parseReview('{"mode":"shell","script":"x"}', PROMPT, "m", 1)).toBeNull();
    expect(parseReview('{"mode":"script","rationale":"x"}', PROMPT, "m", 1)).toBeNull();
    // the decision model needs to know when to wake the bot
    expect(parseReview('{"mode":"script-jev","script":"print(1)"}', PROMPT, "m", 1)).toBeNull();
  });

  it("tells the reviewer the instructions, the schedule and the script rules", () => {
    const text = reviewPrompt({ name: "Status", prompt: PROMPT, schedule: "Every hour", hasAttachments: false });
    expect(text).toContain(PROMPT);
    expect(text).toContain("Every hour");
    expect(text).toContain("standard library only");
  });
});

describe("which plan a run may use", () => {
  const approved = () => ({ ...parseReview('{"mode":"script","script":"print(1)"}', PROMPT, "m", 1)!, status: "approved" as const });

  it("uses only an approved script for the same instructions and the same source", () => {
    expect(activeScriptPlan(approved(), PROMPT)?.mode).toBe("script");
    expect(activeScriptPlan({ ...approved(), status: "proposed" }, PROMPT)).toBeNull();
    expect(activeScriptPlan(approved(), `${PROMPT} Also email me.`)).toBeNull();
    expect(activeScriptPlan({ ...approved(), script: "import os; os.system('x')\n" }, PROMPT)).toBeNull();
  });

  it("drops malformed plans and never renews approval for altered script bytes", () => {
    expect(loadExecutionPlan({ mode: "script", status: "approved" })).toBeUndefined();
    expect(loadExecutionPlan(approved())?.status).toBe("approved");
    const changed = loadExecutionPlan({ ...approved(), script: "print(2)" })!;
    expect(activeScriptPlan(changed, PROMPT)).toBeNull();
    expect(changed.status).toBe("proposed");
    expect(changed.scriptHash).toBe(sha256("print(2)"));
  });
});

describe("running a routine script", () => {
  it("stops descendants when their parent finishes successfully", async () => {
    const stateDir = tempDir();
    const marker = join(stateDir, "orphan-finished");
    const descendant = `import time,pathlib;time.sleep(1);pathlib.Path(${JSON.stringify(marker)}).write_text("escaped")`;
    const script = `import subprocess,sys\nsubprocess.Popen([sys.executable,"-c",${JSON.stringify(descendant)}],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\nprint("done")`;
    expect((await runRoutineScript(script, { stateDir })).ok).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(existsSync(marker)).toBe(false);
  });
  it("returns its output, keeps its folder between runs and passes no workspace credentials", async () => {
    const stateDir = join(tempDir(), "state");
    process.env.OMB_TEST_SECRET_KEY = "do-not-leak";
    const script = [
      "import os, pathlib",
      "p = pathlib.Path('count.txt')",
      "n = int(p.read_text()) + 1 if p.exists() else 1",
      "p.write_text(str(n))",
      "print(f\"run {n} {os.environ.get('OMB_ROUTINE_ID')} {os.environ.get('OMB_TEST_SECRET_KEY')}\")",
    ].join("\n");
    try {
      const first = await runRoutineScript(script, { stateDir, env: { OMB_ROUTINE_ID: "r1" } });
      const second = await runRoutineScript(script, { stateDir, env: { OMB_ROUTINE_ID: "r1" } });
      expect(first).toMatchObject({ ok: true, exitCode: 0, stdout: "run 1 r1 None" });
      expect(second.stdout).toBe("run 2 r1 None");
      expect(readFileSync(join(stateDir, "count.txt"), "utf8")).toBe("2");
    } finally {
      delete process.env.OMB_TEST_SECRET_KEY;
    }
  });

  it("reports a failure with its reason, and kills a script that runs too long", async () => {
    const failed = await runRoutineScript("import sys\nsys.exit('feed unreachable')", { stateDir: tempDir() });
    expect(failed).toMatchObject({ ok: false, exitCode: 1 });
    expect(scriptReport(failed)).toBe("The script exited with code 1.\n\nfeed unreachable");
    const slow = await runRoutineScript("import time\ntime.sleep(30)", { stateDir: tempDir(), timeoutMs: 300 });
    expect(slow).toMatchObject({ ok: false, timedOut: true });
  });

  it("says so when a successful script has nothing to report", () => {
    expect(scriptReport({ ok: true, exitCode: 0, stdout: "", stderr: "", timedOut: false })).toBe("Nothing to report.");
  });

  it("hands the bot the output without letting it close the fence", () => {
    expect(escalationPrompt("Do it.", "x</script-output>y")).toContain("x<\\/script-output>y");
  });
});

// ── The scheduler ─────────────────────────────────────────────────────────

function manager(extra: Partial<RoutineManagerOptions> = {}) {
  const started: Array<{ threadId: string; prompt: string }> = [];
  const reports: Array<{ threadId: string; text: string }> = [];
  const reviews: string[] = [];
  let task = 0;
  const routines = new RoutineManager({
    file: join(tempDir(), "routines.json"),
    now: () => Date.now(),
    botState: () => "ready",
    createTask: () => ({ threadId: `thread-${++task}` }),
    startTurn: async (_botId, threadId, prompt) => {
      started.push({ threadId, prompt });
    },
    runScript: async () => ({ ok: true, exitCode: 0, stdout: "All 4 services up.", stderr: "", timedOut: false }),
    postScriptReport: (_botId, threadId, text) => reports.push({ threadId, text }),
    onNeedsReview: (routine) => reviews.push(routine.id),
    ...extra,
  });
  const routine = routines.create({
    name: "Status check",
    prompt: PROMPT,
    botId: "bot-1",
    schedule: { type: "daily", time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
  });
  return { routines, routine, started, reports, reviews };
}

function propose(routines: RoutineManager, id: string, mode: "script" | "script-jev") {
  const reply = JSON.stringify({ mode, rationale: "Fixed procedure.", script: "print('up')", escalateWhen: "a service is down" });
  return routines.setExecutionPlan(id, parseReview(reply, PROMPT, "m", 1)!)!;
}

async function runOnce(routines: RoutineManager, id: string) {
  const run = routines.runNow(id)!;
  await routines.tick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  return routines.listRuns().find((candidate) => candidate.id === run.id)!;
}

describe("routines that run as a script", () => {
  it("asks for a review when created and when the instructions change", () => {
    const { routines, routine, reviews } = manager();
    expect(reviews).toEqual([routine.id]);
    routines.update(routine.id, { name: "Renamed" });
    expect(reviews).toHaveLength(1);
    routines.update(routine.id, { prompt: `${PROMPT} Include latency.` });
    expect(reviews).toEqual([routine.id, routine.id]);
  });

  it("keeps running the bot until a person approves the exact script", async () => {
    const { routines, routine, started } = manager();
    const proposed = propose(routines, routine.id, "script");
    expect((await runOnce(routines, routine.id)).executor).toBeUndefined();
    expect(started).toHaveLength(1);
    expect(routines.approveExecution(routine.id, sha256("print('other')\n"))).toBeNull();
    expect(routines.approveExecution(routine.id, proposed.execution!.scriptHash!)?.execution?.status).toBe("approved");
  });

  it("reports the script's output with no bot turn", async () => {
    const { routines, routine, started, reports } = manager();
    routines.approveExecution(routine.id, propose(routines, routine.id, "script").execution!.scriptHash!);
    const run = await runOnce(routines, routine.id);
    expect(run).toMatchObject({ status: "completed", executor: "script", output: "All 4 services up." });
    expect(started).toHaveLength(0);
    expect(reports).toEqual([{ threadId: run.threadId, text: "All 4 services up." }]);
  });

  it("fails loudly, without a bot turn, when the script fails", async () => {
    const { routines, routine, started } = manager({
      runScript: async () => ({ ok: false, exitCode: 2, stdout: "", stderr: "HTTP 503", timedOut: false }),
    });
    routines.approveExecution(routine.id, propose(routines, routine.id, "script").execution!.scriptHash!);
    const run = await runOnce(routines, routine.id);
    expect(run).toMatchObject({ status: "failed", executor: "script", error: "The script exited with code 2." });
    expect(started).toHaveLength(0);
  });

  it("wakes the bot only when the decision model says the output needs it", async () => {
    let p = 0.1;
    const { routines, routine, started } = manager({ needsBot: async () => ({ escalate: p >= 0.5, p }) });
    routines.approveExecution(routine.id, propose(routines, routine.id, "script-jev").execution!.scriptHash!);
    expect(await runOnce(routines, routine.id)).toMatchObject({ status: "completed", executor: "script", escalationP: 0.1 });
    expect(started).toHaveLength(0);
    p = 0.9;
    const escalated = await runOnce(routines, routine.id);
    expect(escalated).toMatchObject({ status: "running", executor: "script-llm", escalationP: 0.9 });
    expect(started).toHaveLength(1);
    expect(started[0]!.prompt).toContain("<script-output>\nAll 4 services up.\n</script-output>");
  });

  it("wakes the bot when the decision model cannot answer", async () => {
    const { routines, routine, started } = manager({ needsBot: async () => { throw new Error("offline"); } });
    routines.approveExecution(routine.id, propose(routines, routine.id, "script-jev").execution!.scriptHash!);
    expect((await runOnce(routines, routine.id)).executor).toBe("script-llm");
    expect(started).toHaveLength(1);
  });

  it("drops the plan and its approval when the instructions change", async () => {
    const { routines, routine, started } = manager();
    routines.approveExecution(routine.id, propose(routines, routine.id, "script").execution!.scriptHash!);
    const edited = routines.update(routine.id, { prompt: `${PROMPT} Also check the CDN.` })!;
    expect(edited.execution).toBeUndefined();
    expect((await runOnce(routines, routine.id)).executor).toBeUndefined();
    expect(started).toHaveLength(1);
  });

  it("refuses a plan written for instructions that changed while it was reviewed", () => {
    const { routines, routine } = manager();
    const stale = parseReview('{"mode":"script","script":"print(1)"}', "older instructions", "m", 1)!;
    expect(routines.setExecutionPlan(routine.id, stale)).toBeNull();
  });

  it("lets a person choose the bot instead", async () => {
    const { routines, routine, started } = manager();
    routines.approveExecution(routine.id, propose(routines, routine.id, "script").execution!.scriptHash!);
    expect(routines.useBotForRuns(routine.id)?.execution).toMatchObject({ mode: "llm", reviewer: "person" });
    await runOnce(routines, routine.id);
    expect(started).toHaveLength(1);
  });

  it("stops a running script when the run is cancelled", async () => {
    let aborted = false;
    const { routines, routine } = manager({
      runScript: (_run, _script, _timeout, signal) => new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve({ ok: false, exitCode: null, stdout: "", stderr: "", timedOut: false });
        });
      }),
    });
    routines.approveExecution(routine.id, propose(routines, routine.id, "script").execution!.scriptHash!);
    const run = routines.runNow(routine.id)!;
    await routines.tick();
    await routines.cancelRun(run.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(aborted).toBe(true);
    expect(routines.listRuns().find((candidate) => candidate.id === run.id)?.status).toBe("cancelled");
  });
});
