import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TeachingSessions, normalizeTaughtCall, registerTaughtRuleGuard } from "./teaching-session.ts";
import { librarySkillDirectory } from "./skill-library.ts";
import type { TaughtComputer } from "./teaching-session.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true }); });
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "taught-test-")); roots.push(root);
  const sessions = new TeachingSessions(root);
  const calls: string[] = [];
  const computer: TaughtComputer = { id: "fake:1", kind: "vm", approvalMode: "ask", close: async () => {},
    call: async tool => { calls.push(tool); return { content: [{ type: "text", text: "ok" }] }; } };
  return { root, sessions, calls, computer };
};
const record = async (sessions: TeachingSessions, computer: TaughtComputer) => {
  sessions.start("bot", "thread", computer, "Fill form", "Deterministic example");
  await sessions.perform("bot", "thread", computer, "navigate", { url: "https://example.com" });
  await sessions.perform("bot", "thread", computer, "click", { selector: "#name" });
  await sessions.perform("bot", "thread", computer, "type", { text: "Demo" });
  return sessions.stop("bot", "thread");
};
describe("taught playbook integrity and replay", () => {
  it("saves ordered events and summary, gates approval per bot and stops before later steps", async () => {
    const { sessions, computer, calls } = setup();
    const book = await record(sessions, computer); calls.length = 0;
    const run = sessions.request(book.name, "bot", "thread", computer);
    await sessions.execute(run, async () => computer); expect(calls).toEqual([]);
    sessions.staged(run, "stage"); expect(sessions.approve(run.id, "wrong")).toBeUndefined();
    sessions.approve(run.id, "stage"); await sessions.execute(run, async () => computer);
    expect(calls).toEqual(["navigate", "click", "type"]); expect(run.status).toBe("success");
    expect(sessions.request(book.name, "other-bot", "thread", computer).status).toBe("awaiting-approval");
    calls.length = 0;
    const failed = sessions.request(book.name, "bot", "thread", computer);
    await sessions.execute(failed, async () => ({ ...computer, call: async tool => {
      calls.push(tool); return tool === "click" ? { content: [{ type: "text", text: "element-not-found" }], isError: true } : { content: [] };
    } }));
    expect(calls).toEqual(["navigate", "click"]);
    expect(failed).toMatchObject({ status: "failed", failedStep: 1, completedSteps: 1 });
    sessions.setAlwaysAsk("bot", true);
    expect(sessions.request(book.name, "bot", "thread", computer).status).toBe("awaiting-approval");
  });
  it("rejects modified manifest, wrong kind, changed binding and dangerous tools", async () => {
    const { root, sessions, computer } = setup(); const book = await record(sessions, computer);
    expect(() => sessions.request(book.name, "bot", "thread", { ...computer, kind: "local" })).toThrow("requires vm");
    const run = sessions.request(book.name, "bot", "thread", computer); sessions.staged(run, "stage"); sessions.approve(run.id, "stage");
    await sessions.execute(run, async () => ({ ...computer, id: "fake:2" })); expect(run.status).toBe("failed");
    const path = join(librarySkillDirectory(root, book.name), "playbook.json");
    const modified = JSON.parse(readFileSync(path, "utf8")); modified.steps[2].args.text = "Changed";
    writeFileSync(path, JSON.stringify(modified)); expect(() => sessions.read(book.name)).toThrow("changed");
    expect(() => normalizeTaughtCall("exec", { command: "echo demo" })).toThrow("excluded");
    expect(() => normalizeTaughtCall("download", {})).toThrow("excluded");
    expect(() => normalizeTaughtCall("act", { actions: [{ action: "shell" }] })).toThrow("supported");
  });
  it("preserves request order, refuses stop during pending work and recovers interrupted runs", async () => {
    const { root, sessions, computer } = setup(); sessions.start("bot", "thread", computer, "Observe");
    const first = sessions.begin("bot", "thread", computer.id, "click", { x: 1, y: 2 })!;
    const second = sessions.begin("bot", "thread", computer.id, "type", { text: "Demo" })!;
    second({ content: [] }); expect(() => sessions.stop("bot", "thread")).toThrow("Wait");
    first({ content: [] }); const book = sessions.stop("bot", "thread"); expect(book.steps.map(step => step.action)).toEqual(["click", "type"]);
    const run = sessions.request(book.name, "bot", "thread", computer); sessions.staged(run, "stage"); sessions.approve(run.id, "stage");
    const restarted = new TeachingSessions(root); expect(restarted.run(run.id)).toMatchObject({ status: "failed", failedStep: 0 });
  });
  it("honors optional rules before dispatch with the bot approval mode", async () => {
    const { sessions, computer, calls } = setup(); const book = await record(sessions, computer); calls.length = 0;
    const run = sessions.request(book.name, "bot", "thread", computer); sessions.staged(run, "stage"); sessions.approve(run.id, "stage");
    registerTaughtRuleGuard(async context => { expect(context.approvalMode).toBe("ask"); throw new Error("Rules deny navigation"); });
    await sessions.execute(run, async () => computer); expect(calls).toEqual([]); expect(run).toMatchObject({ status: "failed", failedStep: 0 });
    registerTaughtRuleGuard(async () => {});
  });
  it("discards an interrupted recording without allowing late results into its replacement", () => {
    const { sessions, computer } = setup(); sessions.start("bot", "thread", computer, "Interrupted");
    const finish = sessions.begin("bot", "thread", computer.id, "click", { x: 1, y: 2 })!;
    sessions.discard("bot", "thread"); sessions.start("bot", "thread", computer, "Replacement");
    finish({ content: [] });
    expect(sessions.current("bot", "thread")).toMatchObject({ title: "Replacement", steps: [], pending: 0 });
  });
});
