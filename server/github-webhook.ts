import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { RoutineManager } from "./routines.ts";
import type { WebhookManager, WebhookAttemptOutcome } from "./webhooks.ts";
import type { JsonValue } from "./schema.ts";

const token = z.string().trim().regex(/^[a-z][a-z0-9_]*$/).max(80);
const triggerSchema = z.object({
  secret: z.string().min(1).max(1024),
  repo: z.string().trim().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Use owner/name for the repository").max(200),
  events: z.array(token).min(1).max(100).transform(values => [...new Set(values)]),
  actions: z.array(token).max(100).optional().transform(values => values?.length ? [...new Set(values)] : undefined),
});
export type StoredGithubTrigger = z.output<typeof triggerSchema>;
export function cleanGithubTrigger(value: unknown): StoredGithubTrigger | undefined {
  if (value == null) return undefined;
  const parsed = triggerSchema.safeParse(value);
  if (!parsed.success) throw Object.assign(new Error(`Invalid GitHub trigger: ${parsed.error.issues[0]?.message}`), { status: 400 });
  return parsed.data;
}

export function validGithubSignature(raw: Buffer, secret: string, signature: string | undefined): boolean {
  if (!signature || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}

const eventPayload = z.object({
  repository: z.object({ full_name: z.string().min(1).max(200) }),
  sender: z.object({ login: z.string().max(200) }).optional(),
  action: z.string().max(80).optional(),
  ref: z.string().max(1024).optional(),
  commits: z.array(z.unknown()).optional(),
  head_commit: z.object({ message: z.string() }).nullable().optional(),
  number: z.number().optional(),
  pull_request: z.object({ title: z.string(), merged: z.boolean().nullable().optional() }).optional(),
  issue: z.object({ number: z.number(), title: z.string() }).optional(),
  release: z.object({ tag_name: z.string(), name: z.string().nullable().optional() }).optional(),
});
type GithubPayload = z.output<typeof eventPayload>;
const compact = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 300);
function actionFor(event: string, body: GithubPayload): string | undefined {
  return event === "pull_request" && body.action === "closed" && body.pull_request?.merged === true ? "merged" : body.action;
}
export function githubEventSummary(event: string, body: GithubPayload): string {
  const repo = body.repository.full_name;
  const actor = compact(body.sender?.login ?? "unknown");
  const action = actionFor(event, body);
  if (event === "push") {
    const count = body.commits?.length ?? 0;
    return `GitHub push to ${repo} by ${actor}: ${count} ${count === 1 ? "commit" : "commits"}, ${compact((body.ref ?? "unknown ref").replace(/^refs\/(heads|tags)\//, ""))} — ${compact(body.head_commit?.message?.split("\n")[0] ?? "No head commit")}`;
  }
  if (event === "pull_request") return `GitHub pull_request ${action ?? "updated"} in ${repo} by ${actor}: #${body.number ?? "?"} — ${compact(body.pull_request?.title ?? "")}`;
  if (event === "issues") return `GitHub issues ${action ?? "updated"} in ${repo} by ${actor}: #${body.issue?.number ?? "?"} — ${compact(body.issue?.title ?? "")}`;
  if (event === "release") return `GitHub release ${action ?? "updated"} in ${repo} by ${actor}: ${compact(body.release?.tag_name ?? "")} — ${compact(body.release?.name ?? "")}`;
  return `GitHub ${event}${action ? ` ${action}` : ""} in ${repo} by ${actor}`;
}

export interface GithubIngress {
  receive(routineId: string, raw: Buffer, headers: { signature?: string; event?: string; deliveryId?: string }): { status: number; body: Record<string, JsonValue> };
  reject(routineId: string, status: number, reason: string, headers: { event?: string; deliveryId?: string }): void;
}

export function createGithubIngress(routines: RoutineManager, webhooks: WebhookManager): GithubIngress {
  const log = (id: string, headers: { event?: string; deliveryId?: string }, outcome: WebhookAttemptOutcome, statusCode: number, reason?: string, runId?: string, summary?: string) => {
    webhooks.recordRoutineAttempt(id, { eventName: headers.event, ...(summary ? { payload: summary } : {}) }, { outcome, statusCode, deliveryId: headers.deliveryId, reason, runId });
  };
  return {
    reject: (id, status, reason, headers) => log(id, headers, "rejected", status, reason),
    receive(id, raw, headers) {
      const finish = (outcome: WebhookAttemptOutcome, status: number, body: Record<string, JsonValue>, reason?: string, runId?: string, summary?: string) => {
        log(id, headers, outcome, status, reason, runId, summary);
        return { status, body };
      };
      const trigger = routines.githubTrigger(id);
      if (!trigger || !validGithubSignature(raw, trigger.secret, headers.signature)) return finish("rejected", 401, { error: "Invalid GitHub signature" }, "Invalid GitHub signature");
      if (!headers.event || !/^[a-z][a-z0-9_]{0,79}$/.test(headers.event) || !headers.deliveryId || headers.deliveryId.length > 200) return finish("rejected", 400, { error: "GitHub event and delivery headers are required" }, "Invalid GitHub headers");
      let json: unknown;
      try { json = JSON.parse(raw.toString("utf8")); }
      catch { return finish("rejected", 400, { error: "Invalid JSON webhook body" }, "Invalid JSON webhook body"); }
      // GitHub sends a ping while registering the hook; it never starts work.
      if (headers.event === "ping") return finish("ignored", 200, { ignored: true }, "GitHub ping");
      const parsed = eventPayload.safeParse(json);
      if (!parsed.success) return finish("rejected", 400, { error: "Invalid GitHub event payload" }, "Invalid GitHub event payload");
      const body = parsed.data;
      const routine = routines.listRoutines().find(r => r.id === id);
      const action = actionFor(headers.event, body);
      if (!routine?.enabled || body.repository.full_name.toLowerCase() !== trigger.repo.toLowerCase() || !trigger.events.includes(headers.event) || (trigger.actions?.length && (!action || (!trigger.actions.includes(action) && !trigger.actions.includes(body.action ?? ""))))) return finish("ignored", 200, { ignored: true }, "Routine paused or GitHub filter mismatch");
      const summary = githubEventSummary(headers.event, body);
      try {
        const run = routines.runGithub(id, summary, headers.deliveryId);
        return finish(run.duplicate ? "duplicate" : "accepted", 200, { accepted: true, duplicate: run.duplicate, runId: run.id }, undefined, run.id, summary);
      } catch (error) {
        const status = z.object({ status: z.number().optional() }).safeParse(error);
        const message = error instanceof Error ? error.message : "GitHub delivery failed";
        return finish("rejected", status.success ? status.data.status ?? 500 : 500, { error: message }, message);
      }
    },
  };
}
