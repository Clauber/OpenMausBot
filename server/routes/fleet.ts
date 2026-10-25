import { z } from "zod";
import { newId } from "../contracts.ts";
import { loadConfig, saveConfig } from "../config.ts";
import { auditedWrite, fleetAuditScope, readFleetAudit } from "../fleet-audit.ts";
import { masterAssignment } from "../fleet-authority.ts";
import type { Store } from "../store.ts";
import { PASS, type RouteHandler, type RouteContext } from "./table.ts";

export function fleetOwner(auth: RouteContext["auth"], desktopManaged: boolean): boolean {
  if (auth.kind === "loopback") return desktopManaged && auth.trust !== "service";
  if (!auth.scopes.includes("admin")) return false;
  if (!auth.session.email) return true;
  const config = loadConfig();
  const owner = config.profile?.email ?? config.signIn?.admins?.find(entry => !entry.startsWith("@"));
  return Boolean(owner && owner.toLowerCase() === auth.session.email.toLowerCase());
}

export function createFleetRoutes(deps: { store: Store; desktopManaged: boolean; changed(): void }): RouteHandler {
  return async ({ req, res, path, method, auth, url, json, readBody }) => {
    if (path !== "/api/fleet/master-chief" && path !== "/api/fleet/audit") return PASS;
    if (!fleetOwner(auth, deps.desktopManaged)) return json(res, 403, { error: "Only the owner can manage fleet authority and audit" });
    if (path === "/api/fleet/audit" && method === "GET") {
      const target = url.searchParams.get("target"), actor = url.searchParams.get("actor");
      const entries = readFleetAudit().filter(row => (!actor || row.actorBotId === actor) && (!target || row.changes.some(change => change.targetId === target)));
      return json(res, 200, { entries: entries.map(({ file: _file, beforeHash: _before, afterHash: _after, ...row }) => row) });
    }
    if (path === "/api/fleet/master-chief" && method === "GET") return json(res, 200, masterAssignment());
    if (path !== "/api/fleet/master-chief" || method !== "PUT") return json(res, 405, { error: "Method not allowed" });
    const parsed = z.object({ botId: z.string().regex(/^[\w-]{1,128}$/).nullable() }).strict().safeParse(await readBody(req));
    if (!parsed.success) return json(res, 400, { error: "Choose a Chief of Staff or revoke the assignment" });
    const target = parsed.data.botId ? deps.store.bot(parsed.data.botId) : null;
    if (parsed.data.botId && (!target?.chiefOfStaff || target.hidden)) return json(res, 400, { error: "The Master Chief of Staff must be an existing visible Chief" });
    const current = masterAssignment();
    if (current.botId === parsed.data.botId) return json(res, 200, current);
    fleetAuditScope.run({ botId: null, threadId: null, reason: "assignment", authorize() {} }, () => {
      saveConfig({ masterChiefOfStaffBotId: parsed.data.botId, masterChiefOfStaffRevision: newId() },
        { write: (file, value) => auditedWrite(file, value, "assignment") });
    });
    deps.changed();
    return json(res, 200, masterAssignment());
  };
}
