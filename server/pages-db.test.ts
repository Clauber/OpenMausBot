import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pageContext } from "./pages.ts";
import { PagesDb } from "./pages-db.ts";

describe("pages persistence", () => {
  let dir: string, db: PagesDb;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "omb-pages-")); db = new PagesDb(join(dir, "pages.db")); });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true }); });
  const draft = (title = "Plan", content = "Launch checklist") => ({ revision: 0, title, content });
  it("creates, reads, updates, searches, deletes and persists", () => {
    const page = db.create(draft());
    expect(page).toMatchObject({ spaceId: "personal", parentId: null, revision: 1, sourceThreadId: null });
    expect(db.list()).toHaveLength(1);
    expect(db.search("checklist")[0]?.id).toBe(page.id);
    const updated = db.update(page.id, { revision: 1, title: "Shipping", content: "Release notes" });
    expect(updated.revision).toBe(2);
    expect(db.search("checklist")).toEqual([]);
    expect(db.search("Shipping")[0]?.id).toBe(page.id);
    db.close(); db = new PagesDb(join(dir, "pages.db"));
    expect(db.get(page.id)).toEqual(updated);
    db.delete(page.id, 2);
    expect(db.get(page.id)).toBeNull(); expect(db.search("Release")).toEqual([]);
  });
  it("nests and moves while refusing cycles, missing parents and cross-space parents", () => {
    const parent = db.create(draft());
    const child = db.create({ ...draft("Child"), parentId: parent.id });
    const leaf = db.create({ ...draft("Leaf"), parentId: child.id });
    expect(() => db.move(parent.id, leaf.id, 1)).toThrow("cycle");
    expect(() => db.move(parent.id, parent.id, 1)).toThrow("cycle");
    expect(() => db.move(child.id, "missing", 1)).toThrow("parent");
    expect(() => db.create({ ...draft(), spaceId: "other", parentId: parent.id })).toThrow("space");
    expect(() => db.delete(parent.id, 1)).toThrow("children");
    expect(db.move(child.id, null, 1)).toMatchObject({ parentId: null, revision: 2 });
    db.delete(parent.id, 1);
    expect(db.get(leaf.id)?.parentId).toBe(child.id);
  });
  it("requires revisions for create, update, move and delete", () => {
    expect(() => db.create({ ...draft(), revision: 1 })).toThrow("stale_revision");
    const page = db.create(draft());
    db.update(page.id, { revision: 1, content: "new" });
    for (const mutate of [() => db.update(page.id, { revision: 1, title: "old" }), () => db.move(page.id, null, 1), () => db.delete(page.id, 1)]) {
      expect(mutate).toThrow("stale_revision");
    }
    expect(db.get(page.id)?.content).toBe("new");
  });
  it("search quotes user input and filters spaces", () => {
    db.create(draft("Hello", "café release"));
    db.create({ ...draft("Hello"), spaceId: "other" });
    expect(db.search("hello")).toHaveLength(1);
    expect(db.search('" OR *')).toEqual([]);
    expect(db.search("")).toEqual([]);
    expect(db.search("café")).toHaveLength(1);
  });
  it("deduplicates proposal creation and approval atomically across reopening", () => {
    const first = db.propose("thread", "proposal", "bot", draft());
    expect(db.propose("thread", "proposal", "bot", draft("retry"))).toEqual(first);
    const approved = db.resolveProposal("thread", "proposal", "allow");
    db.close(); db = new PagesDb(join(dir, "pages.db"));
    expect(db.resolveProposal("thread", "proposal", "allow")).toEqual(approved);
    expect(db.list()).toHaveLength(1);
    expect(db.list()[0]).toMatchObject({ title: "Plan", sourceThreadId: "thread" });
    expect(() => db.resolveProposal("thread", "proposal", "deny")).toThrow("already_decided");
  });
  it("reads current page context for only its bound thread and marks truncation", () => {
    const page = db.create(draft("Context", "x".repeat(24_000) + "TAIL_NOT_IN_CONTEXT"));
    db.bindThread(page.id, 1, "page-thread");
    expect(pageContext(db, "other-thread")).toBe("");
    expect(pageContext(db, "page-thread")).toContain('"truncated":true');
    expect(pageContext(db, "page-thread")).not.toContain("TAIL_NOT_IN_CONTEXT");
    db.update(page.id, { revision: 1, content: "LATEST_PAGE_CONTEXT" });
    expect(pageContext(db, "page-thread")).toContain("LATEST_PAGE_CONTEXT");
    expect(pageContext(db, "page-thread")).toContain('"revision":2');
    db.delete(page.id, 2);
    expect(pageContext(db, "page-thread")).toBe("");
  });
  it("rolls back approval when the reviewed parent no longer exists", () => {
    const parent = db.create(draft());
    db.propose("thread", "proposal", "bot", { ...draft("Child"), parentId: parent.id });
    db.delete(parent.id, 1);
    expect(() => db.resolveProposal("thread", "proposal", "allow")).toThrow("parent_not_found");
    expect(db.list()).toEqual([]);
    expect(db.proposal("thread", "proposal")?.state).toBe("pending");
    db.resolveProposal("thread", "proposal", "deny");
  });
  it("denied proposals never create pages, and changed retry payloads cannot replace review copy", () => {
    db.propose("thread", "denied", "bot", draft());
    db.resolveProposal("thread", "denied", "deny");
    expect(() => db.resolveProposal("thread", "denied", "allow")).toThrow("already_decided");
    expect(db.list()).toEqual([]);
  });
});
