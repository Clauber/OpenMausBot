import { z } from "zod";
import { newId } from "./contracts.ts";
import { isMasterChief } from "./fleet-authority.ts";
import { canReachPeer } from "./peer-roster.ts";
import { fleetAuditScope } from "./fleet-audit.ts";
import type { Store } from "./store.ts";

export const masterPermissionSchema = z.object({
  targetBotId: z.string().regex(/^[\w-]{1,128}$/),
  approvalMode: z.enum(["ask", "full", "edits", "auto", "custom"]),
  applyToAllThreads: z.boolean().default(false),
  acknowledgeLocalAuto: z.boolean().optional(),
}).strict().refine(value => !(value.applyToAllThreads && value.approvalMode === "custom"), "Custom cannot be applied to all threads");

export async function changeMasterPermission(deps: {
  store: Pick<Store, "bot">; actorBotId: string; threadId: string;
  requireActive(): void; fullAccess(): boolean;
  invoke(message: Record<string, unknown>, reply: (result: unknown) => void): boolean;
}, input: unknown) {
  const args = masterPermissionSchema.parse(input);
  const check = () => {
    deps.requireActive();
    const actor = deps.store.bot(deps.actorBotId), target = deps.store.bot(args.targetBotId);
    if (!isMasterChief(actor)) throw Object.assign(new Error("Master Chief of Staff authority is required"), { status: 403 });
    if (args.targetBotId === actor!.id) throw Object.assign(new Error("Only the owner can change the master's own permissions"), { status: 403 });
    if (!target || target.hidden || !canReachPeer(actor!, target)) throw Object.assign(new Error("Target is unavailable or has a different audience"), { status: 403 });
    if (!deps.fullAccess()) throw Object.assign(new Error("A Full Access requesting turn is required to change another bot's permissions"), { status: 403 });
  };
  check();
  const requestId = newId();
  const auditActor = fleetAuditScope.getStore();
  if (auditActor) auditActor.operationId = requestId;
  const invoke = (message: Record<string, unknown>) => new Promise<void>((resolve, reject) => {
    check();
    if (!deps.invoke({ ...message, requestId, botId: args.targetBotId, mode: args.approvalMode }, result => {
      const parsed = z.object({ ok: z.boolean(), error: z.string().optional() }).safeParse(result);
      if (!parsed.success || !parsed.data.ok) reject(Object.assign(new Error(parsed.success ? parsed.data.error ?? "The permission transition failed" : "Invalid permission result"), { status: 409 }));
      else resolve();
    })) reject(new Error("The canonical permission handler did not accept this request"));
  });
  await invoke({ type: "approval-trusted-mode-set", allThreads: args.applyToAllThreads,
    ...(args.acknowledgeLocalAuto !== undefined ? { acknowledgeLocalAuto: args.acknowledgeLocalAuto } : {}) });
  const target = deps.store.bot(args.targetBotId);
  if (target?.approvalGrant?.requestId === requestId) {
    for (const phase of ["confirm", "activate", "finalize", "commit"]) await invoke({ type: `approval-trusted-mode-${phase}` });
  }
  return { state: "applied", targetBotId: args.targetBotId, approvalMode: args.approvalMode,
    scope: args.applyToAllThreads ? "all-threads" : "default-only",
    stoppedActiveTurns: args.applyToAllThreads && args.approvalMode === "ask", requestId };
}
