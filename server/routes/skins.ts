// Custom skins over HTTP: the collection the Appearance settings reads and
// edits. All routes are client-scoped (skins carry no secrets and every
// signed-in person shares the workspace's picker — see CLIENT_ALLOW in
// server/request-auth.ts). Persistence and the SSE frames live in
// CustomSkinManager; recipe validation happens there, with the same parser
// the create_skin agent tool uses, so the editor and a bot cannot drift.
import { z } from "zod";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";
import type { CustomSkinManager } from "../custom-skins.ts";

export interface SkinRouteDeps {
  skins: Pick<CustomSkinManager, "list" | "save" | "update" | "remove">;
}

const id = z.string().regex(/^cs-[0-9a-f]{8}$/);
const patchBody = z.object({
  name: z.string().optional(),
  tagline: z.string().optional(),
  recipe: z.record(z.string(), z.unknown()).optional(),
}).strict();

async function bodyOf(req: RouteContext["req"], readBody: RouteContext["readBody"]) {
  try {
    return await readBody(req);
  } catch {
    return undefined;
  }
}

export function createSkinRoutes(deps: SkinRouteDeps): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    if (!path.startsWith("/api/skins")) return PASS;

    if (method === "GET" && path === "/api/skins") {
      return json(res, 200, { skins: deps.skins.list() });
    }

    if (method === "POST" && path === "/api/skins") {
      try {
        const { skin, replaced } = deps.skins.save(await bodyOf(req, readBody));
        return json(res, replaced ? 200 : 201, { skin, replaced });
      } catch (e) {
        const status = (e as { status?: number }).status;
        if (typeof status !== "number") throw e;
        return json(res, status, { error: (e as Error).message });
      }
    }

    const match = path.match(/^\/api\/skins\/(cs-[0-9a-f]{8})$/);
    if (match && method === "PATCH") {
      const parsed = patchBody.safeParse(await bodyOf(req, readBody));
      if (!parsed.success) return json(res, 400, { error: "That skin edit was not valid." });
      const updated = deps.skins.update(id.parse(match[1]), parsed.data);
      if (!updated) return json(res, 404, { error: "That skin no longer exists." });
      return json(res, 200, { skin: updated });
    }
    if (match && method === "DELETE") {
      return json(res, deps.skins.remove(id.parse(match[1])) ? 200 : 404, { ok: true });
    }

    return PASS;
  };
}
