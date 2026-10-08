import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoutinePreCheck } from "../shared/routine-precheck.ts";
import { RoutineManager, type RoutineManagerOptions } from "./routines.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const item = { source: "mail", id: "1", from: "sender@example.com", subject: "Message", snippet: "Please check this" };
const script = (items: unknown = [], extra = "") => ({ command: process.execPath, args: ["-e", `${extra}console.log(${JSON.stringify(JSON.stringify({ items }))})`] });
function harness(decideWake?: RoutineManagerOptions["decideWake"]) {
  const dir = mkdtempSync(join(tmpdir(), "omb-precheck-scheduler-")); dirs.push(dir);
  let now = Date.parse("2026-10-07T10:00:00Z");
  let state: "ready" | "busy" | "missing" = "ready";
  const startTurn = vi.fn<RoutineManagerOptions["startTurn"]>(async () => {});
  const createTask = vi.fn(() => ({ threadId: "execution" }));
  const changed = vi.fn();
  const emit = vi.fn();
  const options: RoutineManagerOptions = { file: join(dir, "routines.json"), now: () => now, botState: () => state, createTask, startTurn, onRunChanged: changed, emit, decideWake };
  const manager = new RoutineManager(options);
  const create = (preCheck: RoutinePreCheck = script()) => manager.create({ name: "Check inbox", prompt: "Handle important mail", botId: "pam", schedule: { type: "once", at: now }, preCheck });
  return { dir, manager, create, startTurn, createTask, changed, emit, options, setState: (next: typeof state) => { state = next; }, advance: () => { now += 60_000; } };
}

describe("routine scheduler pre-check", () => {
  it("empty items skip with only central history, no source card, task or turn", async () => {
    const decision = vi.fn(); const h = harness(decision); h.create();
    await h.manager.tick();
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "skipped", preCheckResult: { state: "skip", reason: "empty" } });
    expect(h.changed).not.toHaveBeenCalled(); expect(h.createTask).not.toHaveBeenCalled(); expect(h.startTurn).not.toHaveBeenCalled(); expect(decision).not.toHaveBeenCalled();
    expect(h.emit.mock.calls.some(([frame]) => frame.kind === "routine.run" && frame.run.status === "skipped")).toBe(true);
  });
  it("only confident validated noise skips; disabled and thrown decisions wake with all items", async () => {
    for (const decide of [undefined, async () => { throw Error("failure"); }, async () => ({ skip: true, reason: "noise_only", probability: 0.699 }), async () => ({ skip: true, reason: "other", probability: 1 })]) {
      const h = harness(decide); h.create(script([item])); await h.manager.tick();
      expect(h.manager.listRuns()[0]?.status).toBe("running"); expect(h.startTurn).toHaveBeenCalledOnce();
      expect(h.startTurn.mock.calls[0]?.[2]).toContain('"id":"1"');
    }
    const h = harness(async () => ({ skip: true, reason: "noise_only", probability: 0.7 })); h.create(script([item])); await h.manager.tick();
    expect(h.manager.listRuns()[0]?.status).toBe("skipped"); expect(h.changed).not.toHaveBeenCalled(); expect(h.startTurn).not.toHaveBeenCalled();
  });
  it("process failure falls back to the original dispatch", async () => {
    const h = harness(); h.create({ command: "/no/such/command", args: [] }); await h.manager.tick();
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "running", preCheckResult: { state: "fallback", reason: "spawn_error" } });
    expect(h.startTurn).toHaveBeenCalledOnce();
  });
  it("manual Run now preserves explicit intent and bypasses the check", async () => {
    const h = harness(); const routine = h.create();
    h.manager.update(routine.id, { enabled: false });
    const run = h.manager.runNow(routine.id)!; await h.manager.tick();
    expect(h.manager.listRuns().find(r => r.id === run.id)).toMatchObject({ status: "running", manual: true });
    expect(h.startTurn).toHaveBeenCalledOnce();
  });
  it.each(["pause", "delete", "cancel"])("%s during decision never resurrects work or drops checked items", async action => {
    let complete!: (value: { skip: boolean; reason: string; probability: number }) => void;
    const decide = vi.fn(() => new Promise<{ skip: boolean; reason: string; probability: number }>(resolve => { complete = resolve; }));
    const h = harness(decide); const routine = h.create(script([item])); const ticking = h.manager.tick();
    await vi.waitFor(() => expect(decide).toHaveBeenCalledOnce());
    const id = h.manager.listRuns()[0]!.id;
    if (action === "pause") h.manager.update(routine.id, { enabled: false });
    if (action === "delete") h.manager.remove(routine.id);
    if (action === "cancel") await h.manager.cancelRun(id);
    complete({ skip: true, reason: "noise_only", probability: 1 }); await ticking;
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "cancelled", preCheckResult: { items: [item] } });
    expect(h.createTask).not.toHaveBeenCalled(); expect(h.startTurn).not.toHaveBeenCalled();
    expect(h.changed).not.toHaveBeenCalled();
  });
  it("target becoming busy after check queues checked data; restart dispatches without rechecking", async () => {
    const h = harness(async () => { h.setState("busy"); return { skip: false, reason: "needs_bot", probability: 0.9 }; });
    const marker = join(h.dir, "checked");
    h.create(script([item], `require('node:fs').appendFileSync(${JSON.stringify(marker)},'x');`));
    await h.manager.tick();
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "queued", preCheckResult: { state: "wake", items: [item] } });
    expect(h.startTurn).not.toHaveBeenCalled();
    h.setState("ready"); const restarted = new RoutineManager(h.options); await restarted.tick();
    expect(h.startTurn).toHaveBeenCalledOnce(); expect(readFileSync(marker, "utf8")).toBe("x");
  });
  it("definition edits during wait cannot redirect the snapshotted run", async () => {
    const h = harness(async () => { h.manager.update(routine.id, { prompt: "New work", botId: "another", preCheck: null }); return { skip: false, reason: "needs_bot" }; });
    const routine = h.create(script([item])); await h.manager.tick();
    const run = h.manager.listRuns()[0]!; expect(run.botId).toBe("pam"); expect(run.prompt).toBe("Handle important mail");
    expect(h.startTurn.mock.calls[0]?.[0]).toBe("pam"); expect(h.startTurn.mock.calls[0]?.[2]).toContain("Handle important mail");
  });
  it("invalid persisted config fails open and legacy records retain dispatch behavior", async () => {
    const h = harness(); h.create(); await h.manager.tick();
    const raw = JSON.parse(readFileSync(h.options.file!, "utf8"));
    const routine = raw.routines[0]; routine.enabled = true; routine.schedule = { type: "once", at: h.options.now!() }; routine.nextRunAt = h.options.now!(); routine.preCheck = { command: "relative", timeoutMs: "bad" }; raw.runs = [];
    writeFileSync(h.options.file!, JSON.stringify(raw)); const restarted = new RoutineManager(h.options); await restarted.tick();
    expect(restarted.listRoutines()).toHaveLength(1); expect(h.startTurn).toHaveBeenCalledOnce();
    delete routine.preCheck; raw.runs = []; writeFileSync(h.options.file!, JSON.stringify(raw));
    const legacy = new RoutineManager(h.options); await legacy.tick(); expect(h.startTurn).toHaveBeenCalledTimes(2);
  });
  it("restarted pending decision uses saved items without running an executable", async () => {
    const h = harness(); h.create(script([item])); h.setState("busy"); await h.manager.tick();
    const raw = JSON.parse(readFileSync(h.options.file!, "utf8")); raw.runs[0].preCheck = { command: "/no/such/command" }; raw.runs[0].preCheckResult = { state: "pending", items: [item] };
    writeFileSync(h.options.file!, JSON.stringify(raw)); h.setState("ready"); const restarted = new RoutineManager(h.options); await restarted.tick();
    expect(restarted.listRuns()[0]).toMatchObject({ status: "running", preCheckResult: { state: "wake", items: [item] } });
  });
});


it("allocates no results conversation for an empty scheduled check", async () => {
  const h = harness(); h.options.resolveResultsThread = vi.fn(() => ({ threadId: "unused" }).threadId);
  const manager = new RoutineManager(h.options);
  manager.create({ name: "Quiet", prompt: "Check mail", botId: "pam", preCheck: script(), schedule: { type: "once", at: h.options.now!() } });
  await manager.tick();
  expect(h.options.resolveResultsThread).not.toHaveBeenCalled();
  expect(manager.listRuns()[0]?.status).toBe("skipped");
});

it("a corrupted persisted pre-check result wakes without running the executable again", async () => {
  const h = harness(); const marker = join(h.dir, "called");
  h.create(script([], `require('node:fs').writeFileSync(${JSON.stringify(marker)},'called');`)); h.setState("busy"); await h.manager.tick();
  const raw = JSON.parse(readFileSync(h.options.file!, "utf8")); raw.runs[0].preCheckResult = { state: "pending", items: [{ source: "wrong" }] };
  writeFileSync(h.options.file!, JSON.stringify(raw)); h.setState("ready"); const restarted = new RoutineManager(h.options); await restarted.tick();
  expect(restarted.listRuns()[0]).toMatchObject({ status: "running", preCheckResult: { state: "fallback", reason: "invalid_persisted_result" } });
  expect(() => readFileSync(marker)).toThrow();
});

it("stopping the manager aborts a check without dispatch, then restart wakes normally", async () => {
  const h = harness(); h.create({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] });
  const ticking = h.manager.tick();
  await vi.waitFor(() => expect(h.manager.listRuns()[0]?.preCheckResult?.state).toBe("pending"));
  h.manager.stop(); await ticking;
  expect(h.startTurn).not.toHaveBeenCalled();
  expect(h.manager.listRuns()[0]).toMatchObject({ status: "queued", preCheckResult: { state: "fallback", reason: "stopped" } });
  const restarted = new RoutineManager(h.options); await restarted.tick(); expect(h.startTurn).toHaveBeenCalledOnce();
});

it("a missing target during decision cannot be recorded as a successful noise skip", async () => {
  const h = harness(async () => { h.setState("missing"); return { skip: true, reason: "noise_only", probability: 1 }; });
  h.create(script([item])); await h.manager.tick();
  expect(h.manager.listRuns()[0]).toMatchObject({ status: "failed", preCheckResult: { items: [item], state: "fallback", reason: "missing_target" } });
  expect(h.startTurn).not.toHaveBeenCalled();
});


it("cancelling an executable check aborts promptly and never creates a turn", async () => {
  const h = harness(); h.create({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 1000 });
  const ticking = h.manager.tick();
  await vi.waitFor(() => expect(h.manager.listRuns()[0]?.preCheckResult?.state).toBe("pending"));
  await h.manager.cancelRun(h.manager.listRuns()[0]!.id); await ticking;
  expect(h.manager.listRuns()[0]?.status).toBe("cancelled");
  expect(h.startTurn).not.toHaveBeenCalled(); expect(h.createTask).not.toHaveBeenCalled();
});
