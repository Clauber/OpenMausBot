import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { DATA_DIR } from "./config.ts";
import type { Page, PageDraft } from "../shared/pages.ts";

export const pageRevision = z.number().int().nonnegative();
export const pageDraftSchema = z.object({
  revision: pageRevision,
  title: z.string().trim().min(1).max(160),
  content: z.string().max(100_000),
  spaceId: z.string().trim().min(1).max(128).optional(),
  parentId: z.string().min(1).max(128).nullable().optional(),
}).strict();
export const pageUpdateSchema = z.object({
  revision: pageRevision,
  title: z.string().trim().min(1).max(160).optional(),
  content: z.string().max(100_000).optional(),
}).strict().refine((v) => v.title !== undefined || v.content !== undefined, "no changes");

export class PageError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 409) { super(code); this.code = code; this.status = status; }
}
export interface PageProposal {
  threadId: string;
  proposalId: string;
  botId: string;
  draft: PageDraft;
  state: "pending" | "allow" | "deny";
  pageId: string | null;
}

/** Synchronous transactions serialize revision checks with writes, including
 * receipt + page creation on approval. A sibling DB keeps migration additive. */
export class PagesDb {
  private handle?: DatabaseSync;
  private file: string;
  constructor(file = join(DATA_DIR, "pages.db")) { this.file = file; }
  private db(): DatabaseSync {
    if (this.handle) return this.handle;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    closeSync(openSync(this.file, "a", 0o600));
    chmodSync(this.file, 0o600);
    const db = new DatabaseSync(this.file);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS pages (
        id TEXT PRIMARY KEY, spaceId TEXT NOT NULL DEFAULT 'default',
        parentId TEXT REFERENCES pages(id), title TEXT NOT NULL, content TEXT NOT NULL,
        revision INTEGER NOT NULL, sourceThreadId TEXT,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pages_parent ON pages(spaceId, parentId);
      CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(title, content, content='pages', content_rowid='rowid', tokenize='unicode61');
      CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
        INSERT INTO pages_fts(rowid,title,content) VALUES(new.rowid,new.title,new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
        INSERT INTO pages_fts(pages_fts,rowid,title,content) VALUES('delete',old.rowid,old.title,old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN
        INSERT INTO pages_fts(pages_fts,rowid,title,content) VALUES('delete',old.rowid,old.title,old.content);
        INSERT INTO pages_fts(rowid,title,content) VALUES(new.rowid,new.title,new.content);
      END;
      CREATE TABLE IF NOT EXISTS page_proposals (
        threadId TEXT NOT NULL, proposalId TEXT NOT NULL, botId TEXT NOT NULL,
        draft TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', pageId TEXT,
        PRIMARY KEY(threadId, proposalId)
      );
      CREATE TABLE IF NOT EXISTS page_threads (
        threadId TEXT PRIMARY KEY, pageId TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE
      );
    `);
    this.handle = db;
    return db;
  }
  close() { this.handle?.close(); this.handle = undefined; }
  private transaction<T>(fn: () => T): T {
    const db = this.db(); db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  get(id: string): Page | null {
    return this.db().prepare("SELECT * FROM pages WHERE id=?").get(id) as unknown as Page ?? null;
  }
  list(spaceId = "default"): Page[] {
    return this.db().prepare("SELECT * FROM pages WHERE spaceId=? ORDER BY title COLLATE NOCASE, id").all(spaceId) as unknown as Page[];
  }
  search(query: string, spaceId = "default"): Page[] {
    const terms = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 32);
    if (!terms?.length) return [];
    const match = terms.map((word) => `"${word}"`).join(" AND ");
    return this.db().prepare(`SELECT p.* FROM pages_fts JOIN pages p ON p.rowid=pages_fts.rowid
      WHERE pages_fts MATCH ? AND p.spaceId=? ORDER BY rank LIMIT 100`).all(match, spaceId) as unknown as Page[];
  }
  private current(id: string, revision: number): Page {
    const page = this.get(id);
    if (!page) throw new PageError("page_not_found", 404);
    if (page.revision !== revision) throw new PageError("stale_revision");
    return page;
  }
  private checkParent(parentId: string | null, spaceId: string, id?: string) {
    const seen = new Set(id ? [id] : []);
    let ancestor = parentId;
    while (ancestor) {
      if (seen.has(ancestor)) throw new PageError("parent_cycle");
      seen.add(ancestor);
      const parent = this.get(ancestor);
      if (!parent) throw new PageError("parent_not_found", 404);
      if (parent.spaceId !== spaceId) throw new PageError("parent_space_mismatch", 400);
      ancestor = parent.parentId;
    }
  }
  private insert(draft: PageDraft, sourceThreadId: string | null): Page {
    if (draft.revision !== 0) throw new PageError("stale_revision");
    const id = randomUUID(), now = Date.now(), spaceId = draft.spaceId ?? "default", parentId = draft.parentId ?? null;
    this.checkParent(parentId, spaceId);
    this.db().prepare(`INSERT INTO pages VALUES(?,?,?,?,?,1,?,?,?)`)
      .run(id, spaceId, parentId, draft.title, draft.content, sourceThreadId, now, now);
    return this.get(id)!;
  }
  create(input: PageDraft, sourceThreadId: string | null = null): Page {
    const draft = pageDraftSchema.parse(input);
    return this.transaction(() => this.insert(draft, sourceThreadId));
  }
  update(id: string, input: z.infer<typeof pageUpdateSchema>): Page {
    const patch = pageUpdateSchema.parse(input);
    return this.transaction(() => {
      const page = this.current(id, patch.revision);
      this.db().prepare("UPDATE pages SET title=?,content=?,revision=revision+1,updatedAt=? WHERE id=?")
        .run(patch.title ?? page.title, patch.content ?? page.content, Date.now(), id);
      return this.get(id)!;
    });
  }
  move(id: string, parentId: string | null, revision: number): Page {
    pageRevision.parse(revision);
    z.string().min(1).max(128).nullable().parse(parentId);
    return this.transaction(() => {
      const page = this.current(id, revision);
      this.checkParent(parentId, page.spaceId, id);
      this.db().prepare("UPDATE pages SET parentId=?,revision=revision+1,updatedAt=? WHERE id=?").run(parentId, Date.now(), id);
      return this.get(id)!;
    });
  }
  delete(id: string, revision: number): void {
    pageRevision.parse(revision);
    this.transaction(() => {
      this.current(id, revision);
      if (this.db().prepare("SELECT id FROM pages WHERE parentId=? LIMIT 1").get(id)) throw new PageError("page_has_children");
      this.db().prepare("DELETE FROM pages WHERE id=?").run(id);
    });
  }
  proposal(threadId: string, proposalId: string): PageProposal | null {
    const row = this.db().prepare("SELECT * FROM page_proposals WHERE threadId=? AND proposalId=?").get(threadId, proposalId);
    return row ? { ...row, draft: JSON.parse(String(row.draft)) } as unknown as PageProposal : null;
  }
  propose(threadId: string, proposalId: string, botId: string, input: PageDraft): PageProposal {
    const draft = pageDraftSchema.parse(input);
    if (draft.revision !== 0) throw new PageError("stale_revision");
    return this.transaction(() => {
      const previous = this.proposal(threadId, proposalId);
      if (previous) {
        if (previous.botId !== botId) throw new PageError("proposal_owner_mismatch", 403);
        return previous;
      }
      this.checkParent(draft.parentId ?? null, draft.spaceId ?? "default");
      this.db().prepare("INSERT INTO page_proposals(threadId,proposalId,botId,draft) VALUES(?,?,?,?)")
        .run(threadId, proposalId, botId, JSON.stringify(draft));
      return this.proposal(threadId, proposalId)!;
    });
  }
  resolveProposal(threadId: string, proposalId: string, decision: "allow" | "deny"): PageProposal {
    return this.transaction(() => {
      const proposal = this.proposal(threadId, proposalId);
      if (!proposal) throw new PageError("proposal_not_found", 404);
      if (proposal.state !== "pending") {
        if (proposal.state !== decision) throw new PageError("already_decided");
        return proposal;
      }
      const page = decision === "allow" ? this.insert(proposal.draft, threadId) : null;
      this.db().prepare("UPDATE page_proposals SET state=?,pageId=? WHERE threadId=? AND proposalId=?")
        .run(decision, page?.id ?? null, threadId, proposalId);
      return this.proposal(threadId, proposalId)!;
    });
  }
  bindThread(pageId: string, revision: number, threadId: string): void {
    this.transaction(() => {
      this.current(pageId, revision);
      this.db().prepare("INSERT INTO page_threads(threadId,pageId) VALUES(?,?)").run(threadId, pageId);
    });
  }
  pageForThread(threadId: string): Page | null {
    return this.db().prepare("SELECT p.* FROM pages p JOIN page_threads t ON t.pageId=p.id WHERE t.threadId=?")
      .get(threadId) as unknown as Page ?? null;
  }
}
export const pagesDb = new PagesDb();
