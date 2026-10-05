// Spaces are authorization boundaries. Every bot, computer, routine, webhook
// and page belongs to exactly one space (threads follow their bot), and one
// chokepoint, assertSpace(), refuses a scoped context that reaches into
// another space. The loopback owner (today's single-operator model) is
// unrestricted and sees every space; isolation binds space-scoped contexts
// (a bot turn, a Telegram binding, a page chat) and entity-to-entity
// references (an @mention, a delegation, a computer a bot would drive).
//
// Storage is one 0600 JSON file in the data directory. An entity with no
// assignment is in the default space, so a data directory that predates
// spaces changes nothing until someone creates a second space.
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";

export const PERSONAL_SPACE_ID = "personal";
export const SPACE_KINDS = ["bot", "computer", "routine", "webhook", "page"] as const;
export type SpaceEntityKind = (typeof SPACE_KINDS)[number];
export interface Space { id: string; name: string; createdAt: number }

/** Pages (LEGION-7) were created with the id "default" before spaces existed. */
export function normalizeSpaceId(id: string | null | undefined): string {
  return !id || id === "default" ? PERSONAL_SPACE_ID : id;
}

/** Who is acting. `owner` is unrestricted; `space` may touch one space only. */
export type ScopeCtx =
  | { kind: "owner" }
  | { kind: "space"; spaceId: string; actor: string };
export const OWNER_SCOPE: ScopeCtx = { kind: "owner" };
export const spaceScope = (spaceId: string, actor = "scoped"): ScopeCtx => ({ kind: "space", spaceId: normalizeSpaceId(spaceId), actor });

export class SpaceIsolationError extends Error {
  readonly status = 403;
  readonly code = "space_isolation";
  readonly space: string;
  constructor(space: string, message = "This belongs to a different space") { super(message); this.space = space; }
  body() { return { error: this.message, code: this.code, space: this.space }; }
}

/** THE chokepoint. Everything that crosses a space goes through here. */
export function assertSpace(ctx: ScopeCtx, entitySpaceId: string | null | undefined): void {
  if (ctx.kind === "owner") return;
  const target = normalizeSpaceId(entitySpaceId);
  if (target !== ctx.spaceId) throw new SpaceIsolationError(target);
}

/** What an HTTP request is scoped to. A caller may narrow itself with
 * `x-omb-space`; nothing can widen a scope, so the header never grants access. */
export function scopeFromHeaders(headers: Record<string, string | string[] | undefined>, actor = "request"): ScopeCtx {
  const raw = headers["x-omb-space"];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return value ? spaceScope(value, actor) : OWNER_SCOPE;
}

export class SpaceError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) { super(message); this.status = status; }
}

const idSchema = z.string().min(1).max(128).regex(/^[\w.-]+$/);
const nameSchema = z.string().trim().min(1).max(60);
const fileSchema = z.object({
  version: z.literal(1),
  spaces: z.array(z.object({ id: idSchema, name: nameSchema, createdAt: z.number() }).strict()).min(1).max(100),
  assignments: z.record(z.string(), z.record(z.string(), z.string())),
  /** Delegation across spaces is refused unless the pair is listed here. */
  allow: z.array(z.object({ from: idSchema, to: idSchema }).strict()).max(500),
}).strict();
type FileShape = z.infer<typeof fileSchema>;

/** Relationships the registry cannot know itself: a thread, routine or
 * webhook follows its bot unless it was assigned explicitly. */
export interface SpaceLinks {
  botOfThread?(threadId: string): string | undefined;
  botOfRoutine?(routineId: string): string | undefined;
  botOfWebhook?(webhookId: string): string | undefined;
  /** Entities that live outside the registry (pages) and so block deleting a space. */
  externalCount?(spaceId: string): number;
}

export class SpaceRegistry {
  private state: FileShape;
  private readonly file: string;
  private links: SpaceLinks;
  constructor(file: string, links: SpaceLinks = {}, existing: Partial<Record<SpaceEntityKind, readonly string[]>> = {}) {
    this.file = file; this.links = links;
    const fresh = (): FileShape => ({ version: 1, spaces: [{ id: PERSONAL_SPACE_ID, name: "Personal", createdAt: Date.now() }], assignments: {}, allow: [] });
    if (existsSync(file)) {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_000_000) throw new SpaceError("spaces file is unsafe", 503);
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      // A damaged file must not silently drop isolation: refuse to start rather than reset.
      if (!parsed.success) throw new SpaceError("spaces file could not be loaded", 503);
      this.state = parsed.data;
      if (!this.state.spaces.some((space) => space.id === PERSONAL_SPACE_ID)) this.state.spaces.unshift({ id: PERSONAL_SPACE_ID, name: "Personal", createdAt: Date.now() });
    } else {
      // First load: everything that already exists moves into the default space.
      this.state = fresh();
      for (const kind of SPACE_KINDS) for (const id of existing[kind] ?? []) (this.state.assignments[kind] ??= {})[id] = PERSONAL_SPACE_ID;
      this.save();
    }
  }
  setLinks(links: SpaceLinks): void { this.links = links; }
  private save(): void { writeFileAtomic(this.file, JSON.stringify(this.state, null, 2), { mode: 0o600 }); }

  list(): Space[] { return this.state.spaces.map((space) => ({ ...space })); }
  get(id: string): Space | undefined { return this.state.spaces.find((space) => space.id === normalizeSpaceId(id)); }
  private require(id: string): Space {
    const space = this.get(id);
    if (!space) throw new SpaceError("no such space", 404);
    return space;
  }
  create(name: string): Space {
    const clean = nameSchema.parse(name);
    if (this.state.spaces.some((space) => space.name.toLowerCase() === clean.toLowerCase())) throw new SpaceError("a space with this name already exists");
    if (this.state.spaces.length >= 100) throw new SpaceError("space limit reached");
    const space = { id: randomUUID(), name: clean, createdAt: Date.now() };
    this.state.spaces.push(space); this.save();
    return { ...space };
  }
  rename(id: string, name: string): Space {
    const space = this.require(id), clean = nameSchema.parse(name);
    if (this.state.spaces.some((other) => other.id !== space.id && other.name.toLowerCase() === clean.toLowerCase())) throw new SpaceError("a space with this name already exists");
    space.name = clean; this.save();
    return { ...space };
  }
  /** Delete only an empty space; the default space is permanent. */
  delete(id: string): void {
    const space = this.require(id);
    if (space.id === PERSONAL_SPACE_ID) throw new SpaceError("the default space cannot be deleted");
    if (this.count(space.id) > 0) throw new SpaceError("space is not empty: move or remove its bots, computers, routines, webhooks and pages first");
    this.state.spaces = this.state.spaces.filter((other) => other.id !== space.id);
    this.state.allow = this.state.allow.filter((pair) => pair.from !== space.id && pair.to !== space.id);
    this.save();
  }
  /** Entities explicitly placed in `spaceId`, plus anything held outside the registry. */
  count(spaceId: string): number {
    const id = normalizeSpaceId(spaceId);
    let total = this.links.externalCount?.(id) ?? 0;
    for (const kind of SPACE_KINDS) for (const target of Object.values(this.state.assignments[kind] ?? {})) if (normalizeSpaceId(target) === id) total += 1;
    return total;
  }

  assign(kind: SpaceEntityKind, id: string, spaceId: string): void {
    this.require(spaceId);
    (this.state.assignments[kind] ??= {})[id] = normalizeSpaceId(spaceId);
    this.save();
  }
  forget(kind: SpaceEntityKind, id: string): void {
    if (this.state.assignments[kind]?.[id] === undefined) return;
    delete this.state.assignments[kind]![id]; this.save();
  }
  assignments(): Record<string, Record<string, string>> {
    return Object.fromEntries(SPACE_KINDS.map((kind) => [kind, { ...this.state.assignments[kind] }]));
  }

  /** The space an entity lives in. Unknown or unassigned entities are in the default space. */
  spaceOf(kind: SpaceEntityKind | "thread", id: string): string {
    if (kind === "thread") {
      const bot = this.links.botOfThread?.(id);
      return bot ? this.spaceOf("bot", bot) : PERSONAL_SPACE_ID;
    }
    const explicit = this.state.assignments[kind]?.[id];
    if (explicit) return this.get(explicit) ? normalizeSpaceId(explicit) : PERSONAL_SPACE_ID;
    const owner = kind === "routine" ? this.links.botOfRoutine?.(id) : kind === "webhook" ? this.links.botOfWebhook?.(id) : undefined;
    return owner ? this.spaceOf("bot", owner) : PERSONAL_SPACE_ID;
  }

  allowDelegation(from: string, to: string): void {
    this.require(from); this.require(to);
    if (!this.delegationAllowed(from, to)) { this.state.allow.push({ from: normalizeSpaceId(from), to: normalizeSpaceId(to) }); this.save(); }
  }
  revokeDelegation(from: string, to: string): void {
    this.state.allow = this.state.allow.filter((pair) => !(pair.from === normalizeSpaceId(from) && pair.to === normalizeSpaceId(to))); this.save();
  }
  allowlist(): Array<{ from: string; to: string }> { return this.state.allow.map((pair) => ({ ...pair })); }
  delegationAllowed(from: string, to: string): boolean {
    const a = normalizeSpaceId(from), b = normalizeSpaceId(to);
    return a === b || this.state.allow.some((pair) => pair.from === a && pair.to === b);
  }

  /** Entity-to-entity reference: may `fromBot` mention, ask or delegate to `toBot`? */
  botMayReachBot(fromBotId: string, toBotId: string): boolean {
    return this.delegationAllowed(this.spaceOf("bot", fromBotId), this.spaceOf("bot", toBotId));
  }
  /** Chokepoint wrapper for a bot reaching another bot; throws SpaceIsolationError. */
  assertBotReachesBot(fromBotId: string, toBotId: string): void {
    const from = this.spaceOf("bot", fromBotId), to = this.spaceOf("bot", toBotId);
    if (!this.delegationAllowed(from, to)) throw new SpaceIsolationError(to, "That bot is in a different space");
  }
  /** A bot driving a computer: the computer must be in the bot's own space. */
  assertBotUsesComputer(botId: string, computerId: string): void {
    assertSpace(spaceScope(this.spaceOf("bot", botId), botId), this.spaceOf("computer", computerId));
  }
}

// ── request guard ──────────────────────────────────────────────────────
const SUBJECTS: Array<[RegExp, SpaceEntityKind | "thread"]> = [
  [/^\/api\/bots\/([\w-]+)(?:\/|$)/, "bot"],
  [/^\/api\/threads\/([\w-]+)(?:\/|$)/, "thread"],
  [/^\/api\/routines\/([\w-]+)(?:\/|$)/, "routine"],
  [/^\/api\/webhooks\/([\w-]+)(?:\/|$)/, "webhook"],
  [/^\/api\/pages\/([\w-]+)(?:\/|$)/, "page"],
  [/^\/api\/(?:team-computers|computers)\/([\w-]+)(?:\/|$)/, "computer"],
];
const NOT_AN_ID = new Set(["search", "from-conversation", "wake", "seen-all"]);

/** The entity a request path names, if any. */
export function spaceSubject(path: string): { kind: SpaceEntityKind | "thread"; id: string } | null {
  for (const [pattern, kind] of SUBJECTS) {
    const m = pattern.exec(path);
    if (m && !NOT_AN_ID.has(m[1]!)) return { kind, id: m[1]! };
  }
  return null;
}

export interface GuardOptions {
  /** Space of a page, which lives in its own database. */
  pageSpace?(id: string): string | undefined;
  /** Unknown ids go on to their handler, which answers "not found" itself. */
  exists?(kind: SpaceEntityKind | "thread", id: string): boolean;
}

/** The one request-level check: resolve the entity a request names, and the
 * space a list or create names, and pass each through assertSpace exactly
 * once. The owner is unrestricted, so for them this is a no-op. */
export function guardRequest(registry: SpaceRegistry, ctx: ScopeCtx, path: string, search: URLSearchParams, options: GuardOptions = {}): void {
  if (ctx.kind === "owner") return;
  const subject = spaceSubject(path);
  if (subject) {
    if (options.exists && !options.exists(subject.kind, subject.id)) return;
    const space = subject.kind === "page" ? options.pageSpace?.(subject.id) : registry.spaceOf(subject.kind, subject.id);
    if (subject.kind === "page" && space === undefined) return;
    return assertSpace(ctx, space);
  }
  const requested = search.get("spaceId");
  if (requested && /^\/api\/pages(?:\/search)?$/.test(path)) assertSpace(ctx, requested);
}

// ── process-wide handle ────────────────────────────────────────────────
// peer-roster.ts is pure and imported everywhere; it asks this handle whether
// two bots share a space. Unset (tests, a server that has not loaded spaces)
// means no extra restriction.
let active: SpaceRegistry | undefined;
export function setActiveSpaces(registry: SpaceRegistry | undefined): void { active = registry; }
export function activeSpaces(): SpaceRegistry | undefined { return active; }
export function spacesAllowBots(fromBotId: string, toBotId: string): boolean {
  return active ? active.botMayReachBot(fromBotId, toBotId) : true;
}
