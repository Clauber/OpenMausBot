// How a routine's runs execute, decided once instead of paid for every run.
//
// A routine is a bot turn on every run by default. Much recurring work is a
// fixed procedure (fetch, compare, format) that a short Python script does
// for free; some needs judgement only when the result is unusual. When a
// routine is created or its instructions change, a reviewer model reads it
// and proposes one of three modes:
//
//   llm         the bot runs every time, as before
//   script      an approved script runs and its output is the report
//   script-jev  the script runs, then the decision model (server/decider)
//               says whether the output needs the bot; only then does a
//               turn start, with the output in hand
//
// A proposed script never runs until a person approves it, and approval
// names the script's hash. Everything fails toward the old behaviour: no
// reviewer, a malformed verdict, a stale plan, or a decision model that
// cannot answer all mean the bot runs as it did before.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { redactSecretsInText } from "./redact.ts";
import type { RoutineExecutionMode, RoutineExecutionPlan } from "../shared/routines.ts";

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const MODES = new Set<RoutineExecutionMode>(["llm", "script", "script-jev"]);
const MAX_SCRIPT_CHARS = 50_000;
const MAX_NOTE_CHARS = 600;

/** The plan a run may use right now, or null to run the bot as before. */
export function activeScriptPlan(
  plan: RoutineExecutionPlan | undefined,
  prompt: string,
): (RoutineExecutionPlan & { mode: "script" | "script-jev"; script: string }) | null {
  if (!plan || plan.status !== "approved" || plan.mode === "llm" || !plan.script) return null;
  if (plan.promptHash !== sha256(prompt) || plan.scriptHash !== sha256(plan.script)) return null;
  return plan as RoutineExecutionPlan & { mode: "script" | "script-jev"; script: string };
}

/** A persisted plan as it may be trusted, or undefined. */
export function loadExecutionPlan(value: unknown): RoutineExecutionPlan | undefined {
  if (!value || typeof value !== "object") return undefined;
  const plan = value as Partial<RoutineExecutionPlan>;
  if (!MODES.has(plan.mode as RoutineExecutionMode)) return undefined;
  if (plan.status !== "proposed" && plan.status !== "approved") return undefined;
  if (typeof plan.rationale !== "string" || typeof plan.promptHash !== "string" || !/^[a-f0-9]{64}$/.test(plan.promptHash)) return undefined;
  if (typeof plan.reviewer !== "string" || !Number.isFinite(plan.reviewedAt)) return undefined;
  if (plan.mode !== "llm" && (typeof plan.script !== "string" || !plan.script.trim())) return undefined;
  return {
    mode: plan.mode!,
    status: plan.status,
    rationale: plan.rationale.slice(0, MAX_NOTE_CHARS),
    ...(plan.mode !== "llm" ? { script: plan.script!, scriptHash: sha256(plan.script!) } : {}),
    ...(plan.mode === "script-jev" && typeof plan.escalateWhen === "string" ? { escalateWhen: plan.escalateWhen.slice(0, MAX_NOTE_CHARS) } : {}),
    promptHash: plan.promptHash,
    reviewer: plan.reviewer.slice(0, 120),
    reviewedAt: plan.reviewedAt!,
    ...(plan.status === "approved" && Number.isFinite(plan.approvedAt) ? { approvedAt: plan.approvedAt } : {}),
  };
}

// ── Review ───────────────────────────────────────────────────────────────

export interface ReviewSubject {
  name: string;
  prompt: string;
  /** Plain words, e.g. "Every weekday at 09:00 (America/New_York)". */
  schedule: string;
  hasAttachments: boolean;
}

export function reviewPrompt(subject: ReviewSubject): string {
  return [
    "You decide how a scheduled automation should run. Running an AI assistant costs money and time on",
    "every run, so prefer a plain Python script whenever one can do the job reliably.",
    "",
    "Choose exactly one mode:",
    '- "script": a Python 3 script can do the whole job deterministically (fetch a URL or JSON API,',
    "  check a status, compare numbers with a threshold, read or write files, format a short report).",
    "  Its standard output is delivered to the person as the report.",
    '- "script-jev": a script can gather the data, but whether the result needs an assistant\'s',
    "  attention is a judgement (an anomaly, an error, something to act on). A fast classifier reads",
    "  the output and wakes the assistant only when needed; otherwise the output is delivered as-is.",
    '- "llm": the job needs judgement or writing on every run, the assistant\'s own tools (logged-in',
    "  accounts, a browser on JavaScript-heavy or login-gated sites, chat, memory, files it keeps,",
    "  connected services), credentials the script would not have, or anything you are unsure a script",
    "  can do correctly.",
    "",
    "Script rules: Python 3 standard library only (urllib, json, re, datetime, csv, sqlite3, …).",
    "No third-party packages. No credentials are available to it. It runs with a time limit, its",
    "working directory is a private folder that persists between runs (use it to remember previous",
    "values, e.g. state.json), and OMB_ROUTINE_LAST_RUN_AT holds the previous run's epoch milliseconds",
    "or is empty. Print the report to stdout as concise Markdown. Print nothing when there is nothing",
    "worth reporting. Exit non-zero on failure, with the reason on stderr.",
    "",
    'Reply with ONLY one JSON object: {"mode": "...", "rationale": "one or two sentences",',
    '"script": "full Python source, for script modes", "escalateWhen": "for script-jev: when the',
    'output needs the assistant, in plain words"}',
    "",
    `Automation name: ${subject.name}`,
    `Schedule: ${subject.schedule}`,
    subject.hasAttachments ? "It has files attached for the assistant to read." : "",
    "Instructions the assistant would receive:",
    "<<<",
    subject.prompt.slice(0, 12_000),
    ">>>",
  ].filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n");
}

/** The first JSON object in a reply, fenced or not. */
function firstJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced ? fenced[1]! : text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** A reviewer reply as a proposed plan, or null when it does not check out. */
export function parseReview(
  reply: string,
  prompt: string,
  reviewer: string,
  at: number,
): RoutineExecutionPlan | null {
  const raw = firstJsonObject(reply);
  if (!raw || typeof raw !== "object") return null;
  const verdict = raw as Record<string, unknown>;
  const mode = verdict.mode as RoutineExecutionMode;
  if (!MODES.has(mode)) return null;
  const rationale = typeof verdict.rationale === "string" ? verdict.rationale.trim().slice(0, MAX_NOTE_CHARS) : "";
  const base = { rationale, promptHash: sha256(prompt), reviewer: reviewer.slice(0, 120), reviewedAt: at };
  // Nothing to approve: the bot runs as it always did.
  if (mode === "llm") return { mode, status: "approved", ...base };
  const script = typeof verdict.script === "string" ? verdict.script.replace(/\r\n/g, "\n").trim() : "";
  if (!script || script.length > MAX_SCRIPT_CHARS) return null;
  const escalateWhen = typeof verdict.escalateWhen === "string" ? verdict.escalateWhen.trim().slice(0, MAX_NOTE_CHARS) : "";
  if (mode === "script-jev" && !escalateWhen) return null;
  return {
    mode,
    status: "proposed",
    ...base,
    script: `${script}\n`,
    scriptHash: sha256(`${script}\n`),
    ...(mode === "script-jev" ? { escalateWhen } : {}),
  };
}

export interface ReviewModel {
  /** Shown on the plan, e.g. "sonnet-5". */
  id: string;
  generate(prompt: string, signal: AbortSignal): Promise<string>;
}

export const REVIEW_TIMEOUT_MS = 180_000;

/** An OpenAI-compatible chat completion endpoint as a reviewer. */
export function chatCompletionReviewer(input: {
  baseUrl: string;
  key: string;
  model: string;
  fetch?: typeof fetch;
}): ReviewModel {
  const fetchImpl = input.fetch ?? fetch;
  const endpoint = `${input.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return {
    id: input.model,
    async generate(prompt, signal) {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${input.key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: input.model, messages: [{ role: "user", content: prompt }], temperature: 0 }),
        signal,
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`the reviewer answered HTTP ${response.status}`);
      }
      const body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("the reviewer sent no text");
      return content;
    },
  };
}

export async function reviewRoutine(
  subject: ReviewSubject,
  model: ReviewModel,
  options: { now: () => number; signal?: AbortSignal },
): Promise<RoutineExecutionPlan | null> {
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(REVIEW_TIMEOUT_MS)])
    : AbortSignal.timeout(REVIEW_TIMEOUT_MS);
  const reply = await model.generate(reviewPrompt(subject), signal);
  return parseReview(reply, subject.prompt, model.id, options.now());
}

// ── Script runs ──────────────────────────────────────────────────────────

export interface ScriptResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export const DEFAULT_SCRIPT_TIMEOUT_MS = 10 * 60_000;
const MAX_STDOUT = 64 * 1024;
const MAX_STDERR = 16 * 1024;

/** Run a script with a private persistent working folder, a short fixed
 * environment (no workspace credentials), and a hard time limit that kills
 * its whole process group. */
export function runRoutineScript(
  script: string,
  options: {
    stateDir: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    env?: Record<string, string>;
    python?: string;
  },
): Promise<ScriptResult> {
  mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync(join(tmpdir(), "omb-routine-"));
  const file = join(scratch, "routine.py");
  writeFileSync(file, script, { mode: 0o600 });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? options.stateDir,
    LANG: process.env.LANG ?? "C.UTF-8",
    PYTHONIOENCODING: "utf-8",
    PYTHONDONTWRITEBYTECODE: "1",
    ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
    ...options.env,
  };
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(options.python ?? "python3", [file], {
      cwd: options.stateDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const kill = () => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* already gone */ }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS);
    const onAbort = () => kill();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < MAX_STDOUT) stdout += chunk.slice(0, MAX_STDOUT - stdout.length);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < MAX_STDERR) stderr += chunk.slice(0, MAX_STDERR - stderr.length);
    });
    const finish = (exitCode: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      rmSync(scratch, { recursive: true, force: true });
      resolve({
        ok: !timedOut && !options.signal?.aborted && exitCode === 0,
        exitCode,
        stdout: stdout.trim(),
        stderr: (spawnError ?? stderr).trim(),
        timedOut,
      });
    };
    child.on("error", (error) => finish(null, `could not start Python: ${error.message}`));
    child.on("close", (code) => finish(code));
  });
}

/** What a person reads for a script run: its output, or why it failed. */
export function scriptReport(result: ScriptResult, timeoutMs = DEFAULT_SCRIPT_TIMEOUT_MS): string {
  if (result.ok) return redactSecretsInText(result.stdout) || "Nothing to report.";
  const why = result.timedOut
    ? `The script did not finish within ${Math.round(timeoutMs / 60_000)} minutes.`
    : result.exitCode === null
      ? "The script could not run."
      : `The script exited with code ${result.exitCode}.`;
  const detail = redactSecretsInText(result.stderr || result.stdout).slice(-1_500);
  return detail ? `${why}\n\n${detail}` : why;
}

// ── Escalation ───────────────────────────────────────────────────────────

/** Below this the output is delivered as-is; at or above it the bot runs. */
export const ESCALATION_THRESHOLD = 0.5;
export const ESCALATION_TIMEOUT_MS = 5_000;

export function escalationState(name: string, prompt: string, output: string) {
  return {
    automation: name,
    instructions: prompt.slice(0, 2_000),
    output: output.slice(0, 8_000),
  };
}

export function escalationInstructions(escalateWhen: string): string {
  return `Does this automation output need the assistant to look at it? It does when: ${escalateWhen}`;
}

/** The bot's prompt when a script's output needs it. */
export function escalationPrompt(prompt: string, output: string): string {
  return [
    prompt,
    "",
    "A script already gathered this run's data. Its output was flagged as needing your attention;",
    "work from it rather than collecting the data again:",
    "<script-output>",
    output.replaceAll("</script-output>", "<\\/script-output>"),
    "</script-output>",
  ].join("\n");
}
