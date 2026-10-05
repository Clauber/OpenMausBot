import { z } from "zod";
import type { IncomingMessage } from "node:http";
import type { Store } from "../store.ts";
import { PageError, pageDraftSchema, pageRevision, pageUpdateSchema, type PagesDb } from "../pages-db.ts";
import { PageProposalService, saveConversationAsPage } from "../pages.ts";
import { PASS, type RouteHandler } from "./table.ts";
import { SpaceIsolationError, assertSpace, scopeFromHeaders, spaceScope, type SpaceRegistry } from "../space-scope.ts";

export interface PagesRouteDeps {
  db: PagesDb;
  store: Pick<Store, "activePath" | "botByThread" | "groupByThread" | "bot" | "createTask">;
  proposals: PageProposalService;
  /** Must recheck the live, agents-only turn capability after body receipt. */
  /** Absent in tests that predate spaces: no extra checks then. */
  spaces?: SpaceRegistry;
  authorizeProposal(req: IncomingMessage, body: { fromBotId: string; fromThreadId: string; proposalId: string }): void;
}
export function createPagesRoutes(deps: PagesRouteDeps): RouteHandler {
  return async ({ req, res, path, method, url, auth, json, readBody }) => {
    const internal = path === "/api/internal/page-proposals";
    if (!internal && path !== "/api/pages" && !path.startsWith("/api/pages/")) return PASS;
    // Pages are workspace documents: admin scope until page sharing is designed.
    if (!internal && !auth.scopes.includes("admin")) return json(res, 403, { error: "pages require admin scope" });
    res.setHeader("cache-control", "no-store");
    const scope = scopeFromHeaders(req.headers);
    const spaces = deps.spaces;
    try {
      if (internal && method === "POST") {
        const body = z.object({ fromBotId: z.string().min(1), fromThreadId: z.string().min(1),
          proposalId: z.string().min(1).max(128), draft: pageDraftSchema }).strict().parse(await readBody(req));
        deps.authorizeProposal(req, body);
        // A bot proposes pages only into its own space.
        if (spaces) assertSpace(spaceScope(spaces.spaceOf("bot", body.fromBotId), body.fromBotId), body.draft.spaceId);
        return json(res, 201, deps.proposals.submit(body.fromBotId, body.fromThreadId, body.proposalId, body.draft));
      }
      if (path === "/api/pages/search" && method === "GET") {
        const query = z.string().max(512).parse(url.searchParams.get("q") ?? "");
        return json(res, 200, { pages: deps.db.search(query, url.searchParams.get("spaceId") ?? (scope.kind === "space" ? scope.spaceId : "personal")) });
      }
      if (path === "/api/pages/from-conversation" && method === "POST") {
        const body = pageDraftSchema.omit({ content: true }).extend({ threadId: z.string().min(1).max(128) }).parse(await readBody(req));
        const { threadId, ...draft } = body;
        assertSpace(scope, draft.spaceId);
        if (spaces) assertSpace(spaceScope(draft.spaceId ?? "personal"), spaces.spaceOf("thread", threadId));
        return json(res, 201, { page: saveConversationAsPage(deps.db, deps.store, threadId, draft) });
      }
      if (path === "/api/pages") {
        if (method === "GET") return json(res, 200, { pages: deps.db.list(url.searchParams.get("spaceId") ?? (scope.kind === "space" ? scope.spaceId : "personal")) });
        if (method === "POST") {
          const draft = pageDraftSchema.parse(await readBody(req));
          assertSpace(scope, draft.spaceId);
          return json(res, 201, { page: deps.db.create(draft) });
        }
      }
      const match = path.match(/^\/api\/pages\/([\w-]+)(?:\/(move|chat))?$/);
      if (!match) return json(res, 404, { error: "page route not found" });
      const id = match[1]!, operation = match[2];
      if (operation === "move" && method === "POST") {
        const body = z.object({ revision: pageRevision, parentId: z.string().min(1).max(128).nullable() }).strict().parse(await readBody(req));
        return json(res, 200, { page: deps.db.move(id, body.parentId, body.revision) });
      }
      if (operation === "chat" && method === "POST") {
        const body = z.object({ revision: pageRevision, botId: z.string().min(1).max(128) }).strict().parse(await readBody(req));
        const page = deps.db.get(id);
        if (!page) throw new PageError("page_not_found", 404);
        if (page.revision !== body.revision) throw new PageError("stale_revision");
        const bot = deps.store.bot(body.botId);
        if (!bot || bot.hidden) throw new PageError("bot_not_found", 404);
        // A page chat binds one bot to one page: both must share a space.
        if (spaces) assertSpace(spaceScope(page.spaceId), spaces.spaceOf("bot", bot.id));
        const task = deps.store.createTask(bot.id, `Page: ${page.title}`, false);
        if (!task) throw new PageError("cannot_create_thread");
        deps.db.bindThread(id, body.revision, task.threadId);
        return json(res, 201, { botId: bot.id, task, link: `#/pages/${id}` });
      }
      if (!operation) {
        if (method === "GET") {
          const page = deps.db.get(id);
          if (!page) throw new PageError("page_not_found", 404);
          return json(res, 200, { page });
        }
        if (method === "PATCH" || method === "PUT") return json(res, 200, { page: deps.db.update(id, pageUpdateSchema.parse(await readBody(req))) });
        if (method === "DELETE") {
          const body = z.object({ revision: pageRevision }).strict().parse(await readBody(req));
          deps.db.delete(id, body.revision);
          return json(res, 200, { ok: true });
        }
      }
      return json(res, 405, { error: "method not allowed" });
    } catch (error) {
      if (error instanceof z.ZodError) return json(res, 400, { error: "invalid page input", code: "validation_error" });
      if (error instanceof SpaceIsolationError) return json(res, 403, error.body());
      if (error instanceof PageError) return json(res, error.status, { error: error.message, code: error.code });
      if (error instanceof Error && "status" in error) return json(res, Number(error.status), { error: error.message });
      throw error;
    }
  };
}
