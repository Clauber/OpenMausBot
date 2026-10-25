import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { redactSecretsInText } from "./redact.ts";

export interface FleetAuditActor {
  botId: string | null;
  threadId: string | null;
  operationId?: string;
  receiptIds?: string[];
  reason?: "reload" | "save-failed" | "permission-change" | "assignment" | "room-grant-revocation";
  authorize(): void;
}

/** AsyncLocalStorage follows every continuation an operation starts; a bot's own turn must not run as the actor that queued it. */
export function withoutFleetActor<T>(operation: () => T): T {
  return fleetAuditScope.run(null, operation);
}

const changeSchema = z.object({
  targetId: z.string(), name: z.string(), resourceId: z.string().optional(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
});
const receiptSchema = z.object({
  id: z.string(), at: z.string(), actorBotId: z.string().nullable(), threadId: z.string().nullable(),
  reason: z.string().optional(), scope: z.enum(["bots", "rooms", "assignment", "routines", "communication"]),
  operationId: z.string().optional(), originatingOperationId: z.string().optional(), reconciles: z.string().optional(),
  file: z.string(), beforeHash: z.string(), afterHash: z.string(),
  status: z.enum(["prepared", "applied", "failed", "unknown", "runtime-only"]),
  changes: z.array(changeSchema),
});
export type FleetAuditReceipt = z.infer<typeof receiptSchema>;
const auditFile = join(DATA_DIR, "fleet-audit.json");
export const fleetAuditScope = new AsyncLocalStorage<FleetAuditActor | null>();
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const fields = ["name", "title", "description", "soul", "cwd", "section", "chiefOfStaff", "hidden", "modelSelection",
  "prompt", "schedule", "enabled", "botId", "approvalGrant", "approvalMode", "autoApprove", "alwaysAllow", "peers", "managedSections", "mcpServers", "memberIds", "fleetRoomGrants", "tasks"];

function content(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function snapshots(text: string, scope: FleetAuditReceipt["scope"]): Map<string, Record<string, unknown>> {
  if (!text) return new Map();
  const parsed: unknown = JSON.parse(text);
  if (scope === "assignment") {
    const value = z.object({ masterChiefOfStaffBotId: z.string().nullable().optional(), masterChiefOfStaffRevision: z.string().optional() }).parse(parsed);
    return new Map([["master-assignment", value]]);
  }
  const records = z.array(z.record(z.string(), z.unknown())).parse(scope === "routines" ? z.object({ routines: z.array(z.unknown()) }).parse(parsed).routines : parsed);
  return new Map(records.flatMap(record => {
    if (typeof record.id !== "string") return [];
    const selected: Record<string, unknown> = {};
    for (const field of fields) {
      if (record[field] === undefined) continue;
      if (field === "tasks" && Array.isArray(record.tasks)) {
        selected.tasks = record.tasks.map(task => {
          const checked = z.object({ threadId: z.string(), approvalMode: z.string().optional(), autoApprove: z.boolean().optional(), alwaysAllow: z.array(z.string()).optional() }).safeParse(task);
          return checked.success ? checked.data : null;
        });
      } else selected[field] = record[field];
    }
    return [[record.id, selected] as const];
  }));
}

function changes(before: string, after: string, scope: FleetAuditReceipt["scope"]): FleetAuditReceipt["changes"] {
  const left = snapshots(before, scope), right = snapshots(after, scope);
  return [...new Set([...left.keys(), ...right.keys()])].flatMap(id => {
    const was = left.get(id) ?? null, next = right.get(id) ?? null;
    if (JSON.stringify(was) === JSON.stringify(next)) return [];
    const safe = (value: Record<string, unknown> | null) => value === null ? null :
      z.record(z.string(), z.unknown()).parse(JSON.parse(redactSecretsInText(JSON.stringify(value))));
    const botId = next?.botId ?? was?.botId;
    return [{ targetId: scope === "routines" && typeof botId === "string" ? botId : id,
      ...(scope === "routines" ? { resourceId: id } : {}),
      name: String(next?.name ?? was?.name ?? id), before: safe(was), after: safe(next) }];
  });
}

function save(receipts: FleetAuditReceipt[]): void {
  writeFileAtomic(auditFile, JSON.stringify(receipts), { mode: 0o600 });
}

export function readFleetAudit(): FleetAuditReceipt[] {
  const text = content(auditFile);
  const receipts = text ? z.array(receiptSchema).parse(JSON.parse(text)) : [];
  let changed = false;
  for (const row of receipts) {
    if (row.status !== "prepared") continue;
    const current = digest(content(row.file));
    row.status = current === row.afterHash ? "applied" : current === row.beforeHash ? "failed" : "unknown";
    changed = true;
  }
  if (changed) save(receipts);
  return receipts;
}

export function auditedWrite(file: string, value: string, scope: FleetAuditReceipt["scope"]): void {
  const before = content(file);
  let actor = fleetAuditScope.getStore();
  actor?.authorize();
  const receipts = readFleetAudit();
  const next = scope === "bots" ? snapshots(value, scope) : new Map();
  const recoveries = receipts.filter(row => row.status === "runtime-only" && row.file === file &&
    !receipts.some(receipt => receipt.reconciles === row.id && receipt.status === "applied") && row.changes.every(change => {
      if (!change.after) return false;
      const bot = next.get(change.targetId);
      const tasks = z.array(z.record(z.string(), z.unknown())).safeParse(bot?.tasks);
      const task = change.after.threadId && tasks.success ? tasks.data.find(task => task.threadId === change.after?.threadId) : bot;
      return task && Object.entries(change.after).every(([key, expected]) => key === "threadId" || JSON.stringify(task[key]) === JSON.stringify(expected));
    }));
  if (!actor && scope === "bots") {
    const left = snapshots(before, scope), right = snapshots(value, scope);
    if ([...left].some(([id, prior]) => prior.approvalGrant && !right.get(id)?.approvalGrant)) {
      actor = { botId: null, threadId: null, reason: "permission-change", authorize() {} };
    }
  }
  if (!actor && scope === "rooms") {
    const left = snapshots(before, scope), right = snapshots(value, scope);
    if ([...left].some(([id, prior]) => prior.fleetRoomGrants && JSON.stringify(prior.fleetRoomGrants) !== JSON.stringify(right.get(id)?.fleetRoomGrants))) {
      actor = { botId: null, threadId: null, reason: "room-grant-revocation", authorize() {} };
    }
  }
  if (!actor && recoveries.length) actor = { botId: null, threadId: null, reason: "permission-change", authorize() {} };
  if (!actor) { writeFileAtomic(file, value, { mode: 0o600 }); return; }
  actor.authorize();
  const delta = changes(before, value, scope);
  if (!delta.length && !recoveries.length) { writeFileAtomic(file, value, { mode: 0o600 }); return; }
  actor.operationId ??= randomUUID();
  const revokedGrant = delta.map(change => z.object({ requestId: z.string() }).safeParse(change.before?.approvalGrant))
    .find(grant => grant.success);
  const row: FleetAuditReceipt = { id: randomUUID(), at: new Date().toISOString(),
    actorBotId: actor.botId, threadId: actor.threadId, operationId: actor.operationId, reason: actor.reason, scope,
    ...(revokedGrant?.success ? { originatingOperationId: revokedGrant.data.requestId } : {}),
    file, beforeHash: digest(before), afterHash: digest(value), status: "prepared", changes: delta };
  receipts.push(row);
  (actor.receiptIds ??= []).push(row.id);
  const recoveryRows = recoveries.map(recovery => ({ ...row, id: randomUUID(), actorBotId: recovery.actorBotId,
    threadId: recovery.threadId, operationId: recovery.operationId, reason: "reconciliation", reconciles: recovery.id, changes: recovery.changes }));
  receipts.push(...recoveryRows);
  save(receipts);
  try { writeFileAtomic(file, value, { mode: 0o600 }); }
  catch (error) {
    row.status = "failed";
    for (const recovery of recoveryRows) recovery.status = "failed";
    try { save(receipts); } catch { }
    throw error;
  }
  row.status = "applied";
  for (const recovery of recoveryRows) recovery.status = "applied";
  try { save(receipts); } catch { }
}

export function prepareFleetDispatch(targetId: string, name: string, threadId: string, roomId?: string) {
  const actor = fleetAuditScope.getStore();
  if (!actor) return () => undefined;
  actor.authorize();
  actor.operationId ??= randomUUID();
  const row: FleetAuditReceipt = { id: randomUUID(), at: new Date().toISOString(), actorBotId: actor.botId,
    threadId: actor.threadId, operationId: actor.operationId, scope: "communication", file: "", beforeHash: "", afterHash: "",
    status: "unknown", changes: [{ targetId, name, before: null, after: { threadId, ...(roomId ? { roomId } : {}) } }] };
  const rows = readFleetAudit();
  rows.push(row);
  save(rows);
  (actor.receiptIds ??= []).push(row.id);
  return (requestId?: string, duplicate = false) => {
    const current = readFleetAudit();
    const saved = current.find(receipt => receipt.id === row.id);
    if (!saved) return;
    if (duplicate) current.splice(current.indexOf(saved), 1);
    else {
      saved.status = requestId ? "applied" : "failed";
      saved.changes[0]!.after = { ...saved.changes[0]!.after, requestId: requestId ?? null };
    }
    try { save(current); } catch { }
  };
}

export function recordRuntimeRevocation(targetId: string, before: Record<string, unknown>, after: Record<string, unknown>): void {
  const rows = readFleetAudit();
  const actor = fleetAuditScope.getStore();
  if (actor) actor.operationId ??= randomUUID();
  rows.push({ id: randomUUID(), at: new Date().toISOString(), actorBotId: actor?.botId ?? null,
    threadId: actor?.threadId ?? null, operationId: actor?.operationId,
    reason: "save-failed", scope: "bots", file: join(DATA_DIR, "bots.json"), beforeHash: "", afterHash: "",
    status: "runtime-only", changes: [{ targetId, name: targetId, before, after }] });
  save(rows);
}
