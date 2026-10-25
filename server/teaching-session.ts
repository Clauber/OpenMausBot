import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { redactSecretsInText } from "./redact.ts";
import { STAGED_SKILL_FILE_MAX_BYTES } from "./skills.ts";
import { installLibrarySkill, librarySkillDirectory, listLibrarySkills, readLibrarySkillFile, skillsLibraryRoot } from "./skill-library.ts";
import type { ApprovalMode } from "../shared/approval-mode.ts";
import type { TaughtAction, TaughtListing, TaughtPlaybook, TaughtRun, TaughtStep, TaughtTool } from "../shared/taught-skills.ts";

const actions: Record<string, TaughtAction> = {
  observe: "observe", screenshot: "observe", get_screenshot: "observe", get_window_state: "observe",
  act: "act", click: "click", computer_click: "click", type: "type", type_text: "type",
  key: "key", key_press: "key", press_key: "key", scroll: "scroll",
  navigate: "navigate", open_url: "navigate", browser_navigate: "navigate",
};
const stepSchema = z.object({ action: z.enum(["observe", "act", "click", "type", "key", "scroll", "navigate"]),
  tool: z.string(), args: z.record(z.string(), z.unknown()), screenshots: z.array(z.string().regex(/^[a-f0-9]{64}$/)), error: z.string().optional() }).strict();
const playbookSchema = z.object({ version: z.literal(1), kind: z.literal("taught"), name: z.string().regex(/^taught-[a-z0-9-]+$/),
  title: z.string().min(1).max(120), notes: z.string().max(4000), ownerBotId: z.string(), computerKind: z.string(),
  createdAt: z.string(), steps: z.array(stepSchema).min(1).max(256) }).strict();
const runSchema = z.object({ id: z.string(), name: z.string(), botId: z.string(), threadId: z.string(), computerId: z.string(),
  sha256: z.string(), status: z.enum(["awaiting-approval", "running", "success", "failed", "rejected"]), startedAt: z.string(),
  finishedAt: z.string().optional(), failedStep: z.number().optional(), error: z.string().optional(), completedSteps: z.number(),
  screenshots: z.array(z.array(z.string())), compareScreenshots: z.boolean(), stagedId: z.string().optional() });
const stateSchema = z.object({ runs: z.array(runSchema), approved: z.record(z.string(), z.string()), alwaysAsk: z.record(z.string(), z.boolean()) });
type Session = { id: string; botId: string; threadId: string; computerId: string; computerKind: string; title: string; notes: string; steps: TaughtStep[]; pending: number; tools: TaughtTool[] };
export interface TaughtComputer {
  id: string;
  kind: string;
  approvalMode: ApprovalMode;
  tools?: TaughtTool[];
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}
export type TaughtRuleGuard = (context: { botId: string; threadId: string; approvalMode: ApprovalMode; step: TaughtStep }) => Promise<void>;
let ruleGuard: TaughtRuleGuard | undefined;
/** Optional rules layer registration. A rejected policy promise stops before dispatch. */
export function registerTaughtRuleGuard(guard: TaughtRuleGuard): void { ruleGuard = guard; }
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export const playbookHash = (book: TaughtPlaybook) => hash(JSON.stringify(book));

export function normalizeTaughtCall(tool: string, args: Record<string, unknown>): TaughtAction {
  const action = actions[tool];
  if (!action) throw new Error(`Tool ${tool} cannot be taught. Shell and download tools are excluded.`);
  if (JSON.stringify(args).length > 16_384) throw new Error("Teaching arguments exceed 16KB.");
  if (redactSecretsInText(JSON.stringify(args)) !== JSON.stringify(args)) throw new Error("Secret-like arguments cannot be recorded.");
  if (action === "act") {
    const nested = Array.isArray(args.actions) ? args.actions : [args];
    if (!nested.length || nested.some(value => !value || typeof value !== "object" ||
      !["click", "type", "type_text", "key", "key_press", "scroll", "navigate", "open_url", "observe"].includes(String((value as Record<string, unknown>).action)))) {
      throw new Error("Composite act must contain only supported computer actions.");
    }
  }
  return action;
}

export function taughtResultError(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return "Computer returned no result.";
  const value = result as { isError?: boolean; error?: unknown; content?: Array<{ type?: string; text?: string }> };
  const text = value.content?.filter(item => item.type === "text").map(item => item.text ?? "").join("\n") ?? "";
  if (value.isError || value.error || /element[-_ ]not[-_ ]found|navigation (?:failed|failure)|net::ERR_|"(?:ok|success)"\s*:\s*false/i.test(text)) {
    return redactSecretsInText(String(value.error || text || "Computer action failed.")).slice(0, 2000);
  }
}

export function taughtSummary(book: TaughtPlaybook): string {
  return `---\nname: ${book.name}\ndescription: ${JSON.stringify(`Replay ${book.title} on ${book.computerKind}.`)}\ntags: taught\n---\n\n# ${book.title}\n\n${book.notes}\n\nComputer kind: ${book.computerKind}\nPlaybook SHA-256: ${playbookHash(book)}\n\nReview all arguments before replay. Failed steps stop the run; no automatic retries.\n\n\`\`\`json\n${JSON.stringify(book.steps, null, 2)}\n\`\`\`\n`;
}

export class TeachingSessions {
  private sessions = new Map<string, Session>();
  private state: z.infer<typeof stateSchema>;
  private executing = new Set<string>();
  readonly root: string;
  constructor(root = skillsLibraryRoot()) {
    this.root = root;
    const file = join(root, "taught-state.json");
    this.state = existsSync(file) ? stateSchema.parse(JSON.parse(readFileSync(file, "utf8"))) : { runs: [], approved: {}, alwaysAsk: {} };
    // An interrupted action must never be resumed automatically after restart.
    for (const run of this.state.runs) if (run.status === "running") {
      run.status = "failed"; run.failedStep = run.completedSteps; run.error = "Server restarted during replay; inspect the computer before retrying.";
      run.finishedAt = new Date().toISOString();
    }
    this.persist();
  }
  private persist() {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    writeFileAtomic(join(this.root, "taught-state.json"), JSON.stringify(this.state), { mode: 0o600 });
  }
  private key(botId: string, threadId: string) { return `${botId}:${threadId}`; }
  current(botId: string, threadId: string) { return this.sessions.get(this.key(botId, threadId)); }
  start(botId: string, threadId: string, computer: TaughtComputer, title: string, notes = "") {
    if (this.current(botId, threadId)) throw new Error("A teaching session is already recording.");
    if (!title.trim() || title.length > 120 || notes.length > 4000) throw new Error("A title (1–120 characters) and notes under 4000 characters are required.");
    const session: Session = { id: randomUUID(), botId, threadId, computerId: computer.id, computerKind: computer.kind,
      title: redactSecretsInText(title.trim()), notes: redactSecretsInText(notes), steps: [], pending: 0, tools: (computer.tools ?? []).filter(tool => !!actions[tool.name]) };
    this.sessions.set(this.key(botId, threadId), session);
    return session;
  }
  discard(botId: string, threadId: string) {
    this.sessions.delete(this.key(botId, threadId));
  }
  private screenshots(result: unknown): string[] {
    const refs: string[] = [];
    const content = (result as { content?: Array<{ type?: string; data?: string; mimeType?: string }> } | null)?.content;
    for (const image of content ?? []) if (image.type === "image" && image.data && image.data.length <= 8_000_000) {
      const bytes = Buffer.from(image.data, "base64");
      const ref = createHash("sha256").update(bytes).digest("hex");
      const dir = join(this.root, "taught-screenshots");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileAtomic(join(dir, ref), image.data, { mode: 0o600 });
      refs.push(ref);
    }
    return refs;
  }
  /** Reserve before dispatch, so overlapping calls retain request order. */
  begin(botId: string, threadId: string, computerId: string, tool: string, args: Record<string, unknown>) {
    const session = this.current(botId, threadId);
    if (!session) return undefined;
    if (session.computerId !== computerId) throw new Error("The recording computer changed. Discard this session.");
    if (session.steps.length >= 256) throw new Error("Recording reached the 256-step limit.");
    const action = normalizeTaughtCall(tool, args);
    const step: TaughtStep = { action, tool, args: structuredClone(args), screenshots: [] };
    session.steps.push(step); session.pending++;
    let settled = false;
    return (result: unknown) => {
      if (settled) return;
      settled = true; session.pending--;
      if (this.current(botId, threadId)?.id !== session.id) return;
      step.screenshots = this.screenshots(result);
      step.error = taughtResultError(result);
    };
  }
  async perform(botId: string, threadId: string, computer: TaughtComputer, tool: string, args: Record<string, unknown>) {
    normalizeTaughtCall(tool, args);
    const finish = this.begin(botId, threadId, computer.id, tool, args);
    try { const result = await computer.call(tool, args); finish?.(result); return result; }
    catch (error) { finish?.({ isError: true, content: [{ type: "text", text: String(error) }] }); throw error; }
  }
  stop(botId: string, threadId: string): TaughtPlaybook {
    const session = this.current(botId, threadId);
    if (!session?.steps.length) throw new Error("Record at least one action before saving.");
    if (session.pending) throw new Error("Wait for the current action to finish.");
    const slug = session.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 35) || "demo";
    const book: TaughtPlaybook = { version: 1, kind: "taught", name: `taught-${slug}-${session.id.slice(0, 8)}`,
      title: session.title, notes: session.notes, ownerBotId: botId, computerKind: session.computerKind,
      createdAt: new Date().toISOString(), steps: session.steps };
    if (Buffer.byteLength(taughtSummary(book), "utf8") + 100 > STAGED_SKILL_FILE_MAX_BYTES) throw new Error("The recorded summary exceeds the 32KB approval limit. Discard and record a shorter demonstration.");
    const dir = librarySkillDirectory(this.root, book.name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(join(dir, "playbook.json"), JSON.stringify(book, null, 2), { mode: 0o600 });
    const installed = installLibrarySkill({ name: book.name, instructions: taughtSummary(book), source: "taught", kind: "taught", root: this.root });
    if ("error" in installed) throw new Error(installed.error);
    this.discard(botId, threadId);
    return book;
  }
  read(name: string): TaughtPlaybook {
    if (!/^taught-[a-z0-9-]+$/.test(name)) throw new Error("Invalid taught playbook name.");
    const summary = readLibrarySkillFile(name, this.root);
    const book = playbookSchema.parse(JSON.parse(readFileSync(join(librarySkillDirectory(this.root, name), "playbook.json"), "utf8")));
    if (book.name !== name || !summary || summary !== taughtSummary(book)) throw new Error("Playbook bytes changed after saving. Record a new demonstration.");
    for (const step of book.steps) if (normalizeTaughtCall(step.tool, step.args) !== step.action) throw new Error("Invalid normalized action.");
    return book;
  }
  list(botId: string): TaughtListing[] {
    return listLibrarySkills(this.root).filter(skill => skill.kind === "taught").map(skill => {
      const playbook = this.read(skill.name);
      return { playbook, approved: this.state.approved[this.key(botId, skill.name)] === playbookHash(playbook),
        runs: this.state.runs.filter(run => run.name === skill.name && run.botId === botId).slice(-10).reverse() };
    });
  }
  runningForBot(botId: string) { return this.state.runs.some(run => run.botId === botId && run.status === "running"); }
  alwaysAsk(botId: string) { return this.state.alwaysAsk[botId] ?? false; }
  setAlwaysAsk(botId: string, value: boolean) { this.state.alwaysAsk[botId] = value; this.persist(); }
  request(name: string, botId: string, threadId: string, computer: TaughtComputer, compareScreenshots = false): TaughtRun {
    const book = this.read(name);
    if (book.computerKind !== computer.kind) throw new Error(`Replay requires ${book.computerKind}; bound computer is ${computer.kind}.`);
    if (this.current(botId, threadId)) throw new Error("Stop or discard recording before replay.");
    if (this.state.runs.some(run => run.botId === botId && ["running", "awaiting-approval"].includes(run.status))) throw new Error("Settle this bot's previous replay first.");
    const sha256 = playbookHash(book);
    const approved = !this.alwaysAsk(botId) && this.state.approved[this.key(botId, name)] === sha256;
    const run: TaughtRun = { id: randomUUID(), name, botId, threadId, computerId: computer.id, sha256,
      status: approved ? "running" : "awaiting-approval", startedAt: new Date().toISOString(), completedSteps: 0, screenshots: [], compareScreenshots };
    this.state.runs.push(run);
    // Bound history while preserving outstanding approval cards.
    const finished = this.state.runs.filter(item => item.botId === botId && item.name === name && !["running", "awaiting-approval"].includes(item.status));
    const remove = new Set(finished.slice(0, -9).map(item => item.id));
    this.state.runs = this.state.runs.filter(item => !remove.has(item.id));
    this.persist(); return run;
  }
  run(id: string) { return this.state.runs.find(run => run.id === id); }
  runForStage(stagedId: string) { return this.state.runs.find(run => run.stagedId === stagedId); }
  revoke(botId: string, name: string) { delete this.state.approved[this.key(botId, name)]; this.persist(); }
  staged(run: TaughtRun, stagedId: string) { run.stagedId = stagedId; this.persist(); }
  reject(id: string, error?: string) {
    const run = this.run(id);
    if (!run || run.status !== "awaiting-approval") return;
    run.status = "rejected"; run.error = error; run.finishedAt = new Date().toISOString(); this.persist();
  }
  approve(id: string, stagedId: string) {
    const run = this.run(id);
    if (!run || run.status !== "awaiting-approval" || run.stagedId !== stagedId) return undefined;
    if (playbookHash(this.read(run.name)) !== run.sha256) throw new Error("Playbook changed after approval was requested.");
    this.state.approved[this.key(run.botId, run.name)] = run.sha256;
    run.status = "running"; this.persist(); return run;
  }
  async execute(run: TaughtRun, connect: () => Promise<TaughtComputer>) {
    if (run.status !== "running" || this.executing.has(run.id)) return;
    this.executing.add(run.id);
    let computer: TaughtComputer | undefined;
    try {
      const book = this.read(run.name);
      if (playbookHash(book) !== run.sha256) throw new Error("Playbook changed before replay.");
      computer = await connect();
      if (computer.kind !== book.computerKind || computer.id !== run.computerId) throw new Error("Bound computer changed while waiting for approval.");
      for (const [index, step] of book.steps.entries()) {
        run.failedStep = index;
        await ruleGuard?.({ botId: run.botId, threadId: run.threadId, approvalMode: computer.approvalMode, step });
        normalizeTaughtCall(step.tool, step.args);
        const result = await computer.call(step.tool, structuredClone(step.args));
        const error = taughtResultError(result);
        if (error) throw new Error(error);
        const screenshots = this.screenshots(result);
        run.screenshots.push(screenshots);
        if (run.compareScreenshots && step.screenshots.length && JSON.stringify(screenshots) !== JSON.stringify(step.screenshots)) throw new Error("Screenshot mismatch; replay paused. Inspect the computer before starting a new run.");
        run.completedSteps++; this.persist();
      }
      run.status = "success"; delete run.failedStep;
    } catch (error) {
      run.status = "failed"; run.error = redactSecretsInText(error instanceof Error ? error.message : String(error)).slice(0, 2000);
    } finally {
      run.finishedAt = new Date().toISOString(); this.persist();
      await computer?.close(); this.executing.delete(run.id);
    }
  }
}
