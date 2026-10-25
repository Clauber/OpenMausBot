import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canReachPeer, reachablePeers } from "./peer-roster.ts";
import {
  OWNER_SCOPE, PERSONAL_SPACE_ID, SpaceError, SpaceIsolationError, SpaceRegistry, assertSpace, guardRequest, normalizeSpaceId,
  scopeFromHeaders, setActiveSpaces, spaceScope, spaceSubject,
} from "./space-scope.ts";

let dir: string, file: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "omb-spaces-")); file = join(dir, "spaces.json"); });
afterEach(() => { setActiveSpaces(undefined); rmSync(dir, { recursive: true, force: true }); });

describe("migration", () => {
  it("creates the default space and moves every existing entity into it on first load", () => {
    const registry = new SpaceRegistry(file, {}, { bot: ["b1", "b2"], computer: ["c1"] });
    expect(registry.list().map((space) => space.id)).toEqual([PERSONAL_SPACE_ID]);
    expect(registry.assignments()).toMatchObject({ bot: { b1: "personal", b2: "personal" }, computer: { c1: "personal" } });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // A later load keeps what it saved and does not re-migrate newcomers.
    const again = new SpaceRegistry(file, {}, { bot: ["b1", "b2", "b3"] });
    expect(again.assignments().bot).not.toHaveProperty("b3");
    expect(again.spaceOf("bot", "b3")).toBe("personal");
    expect(normalizeSpaceId("default")).toBe("personal");
  });
  it("refuses a damaged file instead of silently dropping isolation", () => {
    writeFileSync(file, "{not json");
    expect(() => new SpaceRegistry(file)).toThrow();
  });
});

describe("space administration", () => {
  it("creates, renames and deletes only empty spaces", () => {
    const registry = new SpaceRegistry(file, { externalCount: () => 0 }, { bot: ["b1"] });
    const work = registry.create("Work");
    expect(registry.rename(work.id, "Client").name).toBe("Client");
    expect(() => registry.create("client")).toThrow(SpaceError);
    registry.assign("bot", "b1", work.id);
    expect(() => registry.delete(work.id)).toThrow(/not empty/);
    registry.assign("bot", "b1", PERSONAL_SPACE_ID);
    registry.delete(work.id);
    expect(registry.get(work.id)).toBeUndefined();
    expect(() => registry.delete(PERSONAL_SPACE_ID)).toThrow(/default/);
  });
  it("counts pages held outside the registry as occupants", () => {
    let pages = 1;
    const registry = new SpaceRegistry(file, { externalCount: () => pages });
    const work = registry.create("Work");
    expect(() => registry.delete(work.id)).toThrow(/not empty/);
    pages = 0;
    registry.delete(work.id);
  });
});

describe("the chokepoint", () => {
  it("lets the owner through and refuses a scoped context with space_isolation", () => {
    expect(() => assertSpace(OWNER_SCOPE, "anything")).not.toThrow();
    expect(() => assertSpace(spaceScope("a"), "a")).not.toThrow();
    expect(() => assertSpace(spaceScope("personal"), "default")).not.toThrow();
    try { assertSpace(spaceScope("a"), "b"); expect.unreachable(); } catch (error) {
      expect(error).toBeInstanceOf(SpaceIsolationError);
      expect((error as SpaceIsolationError).status).toBe(403);
      expect((error as SpaceIsolationError).body()).toMatchObject({ code: "space_isolation", space: "b" });
    }
  });
  it("only ever narrows a request's scope", () => {
    expect(scopeFromHeaders({})).toEqual(OWNER_SCOPE);
    expect(scopeFromHeaders({ "x-omb-space": "work" })).toMatchObject({ kind: "space", spaceId: "work" });
  });
  it("guards a request on the entity it names, threads following their bot", () => {
    const registry = new SpaceRegistry(file, { botOfThread: (id) => (id === "t-b" ? "bot-b" : id === "t-a" ? "bot-a" : undefined) });
    const work = registry.create("Work");
    registry.assign("bot", "bot-b", work.id);
    const inWork = spaceScope(work.id);
    const guard = (path: string, query = "") => guardRequest(registry, inWork, path, new URLSearchParams(query), { pageSpace: (id) => (id === "p1" ? "personal" : undefined) });
    expect(() => guard("/api/bots/bot-b/tasks")).not.toThrow();
    expect(() => guard("/api/threads/t-b/messages")).not.toThrow();
    expect(() => guard("/api/bots/bot-a/tasks")).toThrow(SpaceIsolationError);
    expect(() => guard("/api/threads/t-a/messages")).toThrow(SpaceIsolationError);
    expect(() => guard("/api/pages/p1")).toThrow(SpaceIsolationError);
    expect(() => guard("/api/pages", "spaceId=personal")).toThrow(SpaceIsolationError);
    expect(() => guardRequest(registry, OWNER_SCOPE, "/api/bots/bot-a/tasks", new URLSearchParams())).not.toThrow();
    expect(spaceSubject("/api/routines/wake")).toBeNull();
  });
  it("makes routines and webhooks follow their bot unless assigned", () => {
    const registry = new SpaceRegistry(file, { botOfRoutine: () => "bot-b", botOfWebhook: () => "bot-b" });
    const work = registry.create("Work");
    registry.assign("bot", "bot-b", work.id);
    expect(registry.spaceOf("routine", "r1")).toBe(work.id);
    registry.assign("webhook", "w1", PERSONAL_SPACE_ID);
    expect(registry.spaceOf("webhook", "w1")).toBe(PERSONAL_SPACE_ID);
  });
});

describe("entity-to-entity references", () => {
  const bots = [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }];
  it("refuses a cross-space mention or delegation unless the pair is allowlisted", () => {
    const registry = new SpaceRegistry(file);
    const work = registry.create("Work");
    registry.assign("bot", "b", work.id);
    setActiveSpaces(registry);
    expect(canReachPeer(bots[0]!, bots[2]!)).toBe(true);
    expect(canReachPeer(bots[0]!, bots[1]!)).toBe(false);
    expect(reachablePeers(bots, bots[0]!).map((bot) => bot.id)).toEqual(["c"]);
    expect(() => registry.assertBotReachesBot("a", "b")).toThrow(SpaceIsolationError);
    registry.allowDelegation(PERSONAL_SPACE_ID, work.id);
    expect(canReachPeer(bots[0]!, bots[1]!)).toBe(true);
    expect(canReachPeer(bots[1]!, bots[0]!)).toBe(false); // one direction only
  });
  it("refuses a bot driving a computer from another space", () => {
    const registry = new SpaceRegistry(file);
    const work = registry.create("Work");
    registry.assign("computer", "box", work.id);
    expect(() => registry.assertBotUsesComputer("a", "box")).toThrow(SpaceIsolationError);
    registry.assign("bot", "a", work.id);
    expect(() => registry.assertBotUsesComputer("a", "box")).not.toThrow();
    expect(JSON.parse(readFileSync(file, "utf8")).assignments.computer.box).toBe(work.id);
  });
});
