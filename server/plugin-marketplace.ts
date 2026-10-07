// Plugin marketplaces: the Claude Code plugin format (a marketplace.json
// catalog whose plugins bundle skills, MCP servers, hooks, commands…) that
// ZCode, Claude Code and Codex all share. OpenMausBot keeps its own installs
// under DATA_DIR/plugins and also lists what each harness on this machine
// already installed. Either kind can be given to all bots or to chosen bots;
// a granted plugin reaches a bot engine-agnostically — its skills join the
// bot's skills index and its MCP servers join the bot's custom servers — so
// a ZCode plugin works for a Codex bot. Hooks, commands, agents and Codex
// apps are listed but not carried over.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { parseStoredMcpServer } from "./mcp-registry.ts";

const run = promisify(execFile);

export type PluginOrigin = "omb" | "claude" | "codex" | "zcode";
/** "all" reaches every bot, including ones made later; a list names bots.
 * A plugin with no entry reaches nobody. */
export type PluginAccess = "all" | string[];

export type MarketplaceSource =
  | { source: "github"; repo: string; ref?: string }
  | { source: "git"; url: string; ref?: string }
  | { source: "url"; url: string }
  | { source: "local"; path: string };

export interface MarketplaceRecord {
  id: string;
  name: string;
  description?: string;
  source: MarketplaceSource;
  addedAt: string;
  lastUpdated: string;
}

interface InstalledRecord {
  name: string;
  marketplace: string;
  version: string;
  installPath: string;
  installedAt: string;
}

interface PluginState {
  version: 1;
  marketplaces: MarketplaceRecord[];
  installed: InstalledRecord[];
  access: Record<string, PluginAccess>;
}

export interface PluginSkill { name: string; description: string; file: string }

export interface PluginContents {
  name: string;
  version?: string;
  description?: string;
  skills: PluginSkill[];
  mcpServers: Record<string, unknown>;
  /** plugin parts this version does not carry over, e.g. "hooks" */
  unsupported: string[];
}

export interface PluginListing {
  key: string;
  origin: PluginOrigin;
  name: string;
  marketplace: string;
  version: string;
  description?: string;
  installPath: string;
  skills: Array<{ name: string; description: string }>;
  mcpServers: string[];
  unsupported: string[];
  access: "off" | PluginAccess;
  /** false when the folder vanished or has nothing this version can use */
  usable: boolean;
}

export interface CatalogEntry {
  name: string;
  description?: string;
  version?: string;
  category?: string;
  author?: string;
  installable: boolean;
  installed: boolean;
}

// ── paths and state ────────────────────────────────────────────────────────

export function pluginsRoot(dataDir: string = DATA_DIR): string {
  return join(dataDir, "plugins");
}
const statePath = (root: string) => join(root, "state.json");
const marketplaceDir = (root: string, id: string) => join(root, "marketplaces", id);

/** The home directory each harness keeps its plugins under. Overridable so a
 * verification fixture never reads the real machine's installs. */
function harnessHome(): string {
  return process.env.OMB_PLUGIN_HARNESS_HOME || homedir();
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const safeSegment = (value: string) => SAFE_SEGMENT.test(value) && value !== "." && value !== "..";

function readState(root: string): PluginState {
  try {
    const parsed = JSON.parse(readFileSync(statePath(root), "utf8")) as Partial<PluginState>;
    return {
      version: 1,
      marketplaces: Array.isArray(parsed.marketplaces) ? parsed.marketplaces : [],
      installed: Array.isArray(parsed.installed) ? parsed.installed : [],
      access: parsed.access && typeof parsed.access === "object" ? parsed.access : {},
    };
  } catch {
    return { version: 1, marketplaces: [], installed: [], access: {} };
  }
}

function writeState(root: string, state: PluginState): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileAtomic(statePath(root), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  contentsCache.clear();
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** `inside` is `root` or below it, compared on resolved paths. */
function within(root: string, inside: string): boolean {
  const rel = relative(resolve(root), resolve(inside));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// ── reading a plugin folder ────────────────────────────────────────────────

const MANIFEST_DIRS = [".claude-plugin", ".zcode-plugin", ".codex-plugin"];

function readManifest(dir: string): Record<string, unknown> {
  for (const sub of MANIFEST_DIRS) {
    const value = readJson(join(dir, sub, "plugin.json"));
    if (isRecord(value)) return value;
  }
  return {};
}

/** Name and description from SKILL.md frontmatter. Lenient on purpose: plugin
 * skills come from many authors, and an index line only needs these two. */
export function readSkillFrontmatter(text: string): { name?: string; description?: string } {
  const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  if (!block) return {};
  const lines = block.split(/\r?\n/);
  const field = (key: string): string | undefined => {
    const index = lines.findIndex((line) => line.startsWith(`${key}:`));
    if (index < 0) return undefined;
    let value = lines[index]!.slice(key.length + 1).trim();
    if (/^[>|][+-]?$/.test(value)) {
      const folded: string[] = [];
      for (const line of lines.slice(index + 1)) {
        if (!/^\s+/.test(line)) break;
        folded.push(line.trim());
      }
      value = folded.join(" ");
    }
    return value.replace(/^["']|["']$/g, "").trim() || undefined;
  };
  return { name: field("name"), description: field("description") };
}

const MAX_SKILLS_PER_PLUGIN = 64;

function readSkills(dir: string, manifest: Record<string, unknown>): PluginSkill[] {
  const declared = manifest.skills;
  const roots = (typeof declared === "string" ? [declared] : Array.isArray(declared) ? declared : ["skills"])
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => resolve(dir, entry))
    .filter((path) => within(dir, path));
  const skills: PluginSkill[] = [];
  for (const root of roots) {
    const candidates = existsSync(join(root, "SKILL.md")) ? [root] : (() => {
      try {
        return readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(root, entry.name));
      } catch {
        return [];
      }
    })();
    for (const folder of candidates.sort()) {
      if (skills.length >= MAX_SKILLS_PER_PLUGIN) return skills;
      const file = join(folder, "SKILL.md");
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const front = readSkillFrontmatter(text);
      const name = front.name || folder.split(/[\\/]/).at(-1)!;
      skills.push({ name, description: (front.description ?? "").slice(0, 1024), file });
    }
  }
  return skills;
}

function readMcpServers(dir: string, manifest: Record<string, unknown>): Record<string, unknown> {
  const declared = manifest.mcpServers;
  let raw: unknown;
  if (isRecord(declared)) raw = declared;
  else if (typeof declared === "string" && within(dir, resolve(dir, declared))) raw = readJson(resolve(dir, declared));
  else raw = readJson(join(dir, ".mcp.json"));
  if (!isRecord(raw)) return {};
  const servers = isRecord(raw.mcpServers) ? raw.mcpServers : raw;
  return Object.fromEntries(Object.entries(servers).filter(([, value]) => isRecord(value)));
}

function unsupportedParts(dir: string, manifest: Record<string, unknown>): string[] {
  const has = (key: string, folder = key) => manifest[key] !== undefined || existsSync(join(dir, folder));
  const parts: string[] = [];
  if (has("hooks")) parts.push("hooks");
  if (has("commands")) parts.push("commands");
  if (has("agents")) parts.push("agents");
  if (manifest.apps !== undefined || existsSync(join(dir, ".app.json"))) parts.push("apps");
  if (manifest.lspServers !== undefined || existsSync(join(dir, ".lsp.json"))) parts.push("lsp");
  return parts;
}

const contentsCache = new Map<string, { at: number; value: PluginContents | null }>();
const CONTENTS_TTL_MS = 15_000;

/** What a plugin folder offers. Cached briefly: bots read this every turn. */
export function inspectPlugin(dir: string, fallbackName = ""): PluginContents | null {
  const hit = contentsCache.get(dir);
  if (hit && Date.now() - hit.at < CONTENTS_TTL_MS) return hit.value;
  let value: PluginContents | null = null;
  try {
    if (statSync(dir).isDirectory()) {
      const manifest = readManifest(dir);
      value = {
        name: typeof manifest.name === "string" ? manifest.name : fallbackName,
        version: typeof manifest.version === "string" ? manifest.version : undefined,
        description: typeof manifest.description === "string" ? manifest.description : undefined,
        skills: readSkills(dir, manifest),
        mcpServers: readMcpServers(dir, manifest),
        unsupported: unsupportedParts(dir, manifest),
      };
    }
  } catch {
    value = null;
  }
  contentsCache.set(dir, { at: Date.now(), value });
  return value;
}

// ── harness discovery ──────────────────────────────────────────────────────

interface FoundPlugin { origin: PluginOrigin; name: string; marketplace: string; version: string; installPath: string }

function splitId(id: string): { name: string; marketplace: string } {
  const at = id.lastIndexOf("@");
  return at > 0 ? { name: id.slice(0, at), marketplace: id.slice(at + 1) } : { name: id, marketplace: "" };
}

function claudePlugins(home: string): FoundPlugin[] {
  const file = readJson(join(home, ".claude", "plugins", "installed_plugins.json"));
  if (!isRecord(file) || !isRecord(file.plugins)) return [];
  const found: FoundPlugin[] = [];
  for (const [id, installs] of Object.entries(file.plugins)) {
    const list = Array.isArray(installs) ? installs : [installs];
    const install = list.find((entry) => isRecord(entry) && typeof entry.installPath === "string");
    if (!isRecord(install)) continue;
    found.push({
      origin: "claude",
      ...splitId(id),
      version: typeof install.version === "string" ? install.version : "",
      installPath: install.installPath as string,
    });
  }
  return found;
}

function zcodePlugins(home: string): FoundPlugin[] {
  const file = readJson(join(home, ".zcode", "cli", "plugins", "installed_plugins.json"));
  if (!isRecord(file) || !Array.isArray(file.plugins)) return [];
  return file.plugins.flatMap((entry): FoundPlugin[] => {
    if (!isRecord(entry) || typeof entry.installPath !== "string") return [];
    const id = typeof entry.id === "string" ? splitId(entry.id) : { name: "", marketplace: "" };
    return [{
      origin: "zcode",
      name: typeof entry.name === "string" ? entry.name : id.name,
      marketplace: typeof entry.marketplace === "string" ? entry.marketplace : id.marketplace,
      version: typeof entry.version === "string" ? entry.version : "",
      installPath: entry.installPath,
    }];
  });
}

/** Codex keeps no install index; its cache is <marketplace>/<plugin>/<version>.
 * The newest version folder holding a manifest is the installed one. */
function codexPlugins(home: string): FoundPlugin[] {
  const cache = join(home, ".codex", "plugins", "cache");
  const dirs = (path: string) => {
    try {
      return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return [];
    }
  };
  const found: FoundPlugin[] = [];
  for (const marketplace of dirs(cache)) {
    for (const name of dirs(join(cache, marketplace))) {
      const versions = dirs(join(cache, marketplace, name))
        .filter((version) => MANIFEST_DIRS.some((sub) => existsSync(join(cache, marketplace, name, version, sub, "plugin.json"))))
        .map((version) => ({ version, at: statSync(join(cache, marketplace, name, version)).mtimeMs }))
        .sort((a, b) => b.at - a.at);
      if (!versions[0]) continue;
      found.push({ origin: "codex", name, marketplace, version: versions[0].version, installPath: join(cache, marketplace, name, versions[0].version) });
    }
  }
  return found;
}

export const pluginKey = (origin: PluginOrigin, name: string, marketplace: string) => `${origin}:${name}@${marketplace}`;

function allPlugins(root: string): FoundPlugin[] {
  const home = harnessHome();
  const own = readState(root).installed.map((entry): FoundPlugin => ({ origin: "omb", ...entry }));
  return [...own, ...claudePlugins(home), ...codexPlugins(home), ...zcodePlugins(home)];
}

export function listPlugins(root: string = pluginsRoot()): PluginListing[] {
  const state = readState(root);
  return allPlugins(root).map((plugin) => {
    const key = pluginKey(plugin.origin, plugin.name, plugin.marketplace);
    const contents = inspectPlugin(plugin.installPath, plugin.name);
    return {
      key,
      origin: plugin.origin,
      name: plugin.name,
      marketplace: plugin.marketplace,
      version: plugin.version || contents?.version || "",
      description: contents?.description,
      installPath: plugin.installPath,
      skills: (contents?.skills ?? []).map(({ name, description }) => ({ name, description })),
      mcpServers: Object.keys(contents?.mcpServers ?? {}),
      unsupported: contents?.unsupported ?? [],
      access: state.access[key] ?? "off",
      usable: !!contents && (contents.skills.length > 0 || Object.keys(contents.mcpServers).length > 0),
    };
  });
}

export function setPluginAccess(key: string, access: "off" | PluginAccess, root: string = pluginsRoot()): PluginListing | { error: string } {
  const listing = listPlugins(root).find((plugin) => plugin.key === key);
  if (!listing) return { error: "No such plugin." };
  const state = readState(root);
  if (access === "off" || (Array.isArray(access) && access.length === 0)) delete state.access[key];
  else state.access[key] = access === "all" ? "all" : [...new Set(access)];
  writeState(root, state);
  return { ...listing, access: state.access[key] ?? "off" };
}

/** Drop a deleted bot from every plugin's list. */
export function forgetBotPluginAccess(botId: string, root: string = pluginsRoot()): void {
  const state = readState(root);
  let changed = false;
  for (const [key, access] of Object.entries(state.access)) {
    if (!Array.isArray(access) || !access.includes(botId)) continue;
    const next = access.filter((id) => id !== botId);
    if (next.length) state.access[key] = next;
    else delete state.access[key];
    changed = true;
  }
  if (changed) writeState(root, state);
}

// ── what a bot receives ────────────────────────────────────────────────────

function grantedPlugins(botId: string, root: string): Array<{ key: string; name: string; contents: PluginContents; dir: string }> {
  const state = readState(root);
  const grants = Object.entries(state.access).filter(([, access]) => access === "all" || access.includes(botId));
  if (!grants.length) return [];
  const byKey = new Map(allPlugins(root).map((plugin) => [pluginKey(plugin.origin, plugin.name, plugin.marketplace), plugin]));
  return grants
    .map(([key]) => key)
    .sort()
    .flatMap((key) => {
      const plugin = byKey.get(key);
      const contents = plugin && inspectPlugin(plugin.installPath, plugin.name);
      return plugin && contents ? [{ key, name: plugin.name, contents, dir: plugin.installPath }] : [];
    });
}

/** Skills a bot gets from its plugins, namespaced `plugin:skill` like the
 * harnesses show them, so they never collide with a bot's own skills. */
export function pluginSkillsForBot(botId: string, root: string = pluginsRoot()): PluginSkill[] {
  const seen = new Set<string>();
  return grantedPlugins(botId, root).flatMap(({ name, contents }) =>
    contents.skills.flatMap((skill) => {
      const qualified = `${name}:${skill.name}`;
      if (seen.has(qualified)) return [];
      seen.add(qualified);
      return [{ ...skill, name: qualified }];
    }));
}

/** `${VAR}` / `${VAR:-default}` from the environment, with the plugin-root
 * variables each harness defines pointing at the plugin's folder. */
export function expandPluginVars(value: string, dir: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback: string | undefined) => {
    if (name === "CLAUDE_PLUGIN_ROOT" || name === "ZCODE_PLUGIN_ROOT" || name === "CODEX_PLUGIN_ROOT" || name === "PLUGIN_ROOT") return dir;
    return env[name] || fallback || "";
  });
}

function expandServer(raw: Record<string, unknown>, dir: string): Record<string, unknown> {
  const str = (value: unknown) => (typeof value === "string" ? expandPluginVars(value, dir) : value);
  const map = (value: unknown) => isRecord(value)
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, str(item)]).filter(([, item]) => item !== ""))
    : value;
  const out: Record<string, unknown> = {};
  for (const key of ["command", "url", "type"]) if (raw[key] !== undefined) out[key] = str(raw[key]);
  if (Array.isArray(raw.args)) out.args = raw.args.map(str);
  if (raw.env !== undefined) out.env = map(raw.env);
  if (raw.headers !== undefined) out.headers = map(raw.headers);
  return out;
}

const mcpSlug = (value: string) => {
  const slug = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "").slice(0, 32).replace(/-+$/, "");
  return slug || "plugin";
};

/** MCP servers a bot gets from its plugins, in the stored-config shape the
 * MCP registry validates. Names already in `taken` (the person's own
 * servers) win; a clash is retried as `plugin-server`, then skipped. */
export function pluginMcpServersForBot(
  botId: string,
  taken: Iterable<string>,
  root: string = pluginsRoot(),
): Record<string, unknown> {
  const used = new Set(taken);
  const out: Record<string, unknown> = {};
  for (const { name, contents, dir } of grantedPlugins(botId, root)) {
    for (const [server, raw] of Object.entries(contents.mcpServers)) {
      const entry = expandServer(raw as Record<string, unknown>, dir);
      const candidates = [mcpSlug(server), mcpSlug(`${name}-${server}`)];
      const chosen = candidates.find((candidate) => !used.has(candidate) && parseStoredMcpServer(candidate, entry).ok);
      if (!chosen) continue;
      used.add(chosen);
      out[chosen] = entry;
    }
  }
  return out;
}

// ── marketplaces ───────────────────────────────────────────────────────────

const GIT_TIMEOUT_MS = 180_000;

async function gitClone(url: string, into: string, ref?: string): Promise<void> {
  const args = ["clone", "--depth", "1", ...(ref ? ["--branch", ref] : []), "--", url, into];
  await run("git", args, { timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

async function gitCheckout(url: string, into: string, ref?: string, sha?: string): Promise<void> {
  if (!sha) return gitClone(url, into, ref);
  // A pinned commit: fetch exactly it, so the installed bytes are the ones
  // the marketplace reviewed.
  const opts = { timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } };
  mkdirSync(into, { recursive: true });
  await run("git", ["init", "-q", into], opts);
  await run("git", ["-C", into, "remote", "add", "origin", url], opts);
  await run("git", ["-C", into, "fetch", "-q", "--depth", "1", "origin", sha], opts);
  await run("git", ["-C", into, "checkout", "-q", "FETCH_HEAD"], opts);
}

/** owner/repo, a GitHub or git URL, an https URL to marketplace.json, or a
 * local folder. */
export function parseMarketplaceSource(input: string): MarketplaceSource | { error: string } {
  const value = input.trim();
  if (!value) return { error: "Enter owner/repo, a git URL, a marketplace.json URL, or a folder." };
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) return { source: "github", repo: value.replace(/\.git$/, "") };
  const github = value.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (github) return { source: "github", repo: github[1]! };
  if (/^https?:\/\/.+\.json(\?.*)?$/i.test(value)) return { source: "url", url: value };
  if (/^(https:\/\/|git@|ssh:\/\/).+/.test(value)) return { source: "git", url: value };
  if (isAbsolute(value)) return { source: "local", path: value };
  return { error: "Enter owner/repo, a git URL, a marketplace.json URL, or a folder." };
}

const MARKETPLACE_FILES = [
  ".claude-plugin/marketplace.json",
  ".zcode-plugin/marketplace.json",
  ".codex-plugin/marketplace.json",
  ".agents/plugins/marketplace.json",
  "marketplace.json",
];

function readMarketplace(dir: string): { file: string; data: Record<string, unknown> } | null {
  for (const rel of MARKETPLACE_FILES) {
    const data = readJson(join(dir, rel));
    if (isRecord(data) && Array.isArray(data.plugins)) return { file: join(dir, rel), data };
  }
  return null;
}

/** Fetch a marketplace's catalog into `into`. */
async function fetchMarketplace(source: MarketplaceSource, into: string, fetcher: typeof fetch): Promise<string> {
  rmSync(into, { recursive: true, force: true });
  if (source.source === "local") return source.path;
  mkdirSync(join(into, ".."), { recursive: true });
  if (source.source === "url") {
    const response = await fetcher(source.url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`The marketplace URL answered ${response.status}.`);
    mkdirSync(into, { recursive: true });
    writeFileSync(join(into, "marketplace.json"), await response.text());
    return into;
  }
  const url = source.source === "github" ? `https://github.com/${source.repo}.git` : source.url;
  await gitClone(url, into, source.ref);
  return into;
}

function marketplaceRoot(root: string, record: MarketplaceRecord): string {
  return record.source.source === "local" ? record.source.path : marketplaceDir(root, record.id);
}

export function listMarketplaces(root: string = pluginsRoot()): MarketplaceRecord[] {
  return readState(root).marketplaces;
}

/** Marketplaces the harnesses on this machine already know, offered as
 * one-click adds. */
export function harnessMarketplaces(): Array<{ origin: PluginOrigin; name: string; input: string }> {
  const home = harnessHome();
  const toInput = (source: unknown): string | null => {
    if (!isRecord(source)) return null;
    if (source.source === "github" && typeof source.repo === "string") return source.repo;
    if ((source.source === "url" || source.source === "git") && typeof source.url === "string") return source.url;
    if (source.source === "directory" && typeof source.path === "string") return source.path;
    return null;
  };
  const out: Array<{ origin: PluginOrigin; name: string; input: string }> = [];
  const claude = readJson(join(home, ".claude", "plugins", "known_marketplaces.json"));
  if (isRecord(claude)) {
    for (const [name, entry] of Object.entries(claude)) {
      const input = isRecord(entry) ? toInput(entry.source) : null;
      if (input) out.push({ origin: "claude", name, input });
    }
  }
  const zcode = readJson(join(home, ".zcode", "cli", "plugins", "known_marketplaces.json"));
  if (isRecord(zcode) && Array.isArray(zcode.marketplaces)) {
    for (const entry of zcode.marketplaces) {
      const input = isRecord(entry) ? toInput(entry.source) : null;
      if (input && isRecord(entry)) out.push({ origin: "zcode", name: String(entry.name ?? entry.id ?? input), input });
    }
  }
  return out;
}

export async function addMarketplace(
  input: string,
  root: string = pluginsRoot(),
  fetcher: typeof fetch = fetch,
): Promise<MarketplaceRecord | { error: string }> {
  const source = parseMarketplaceSource(input);
  if ("error" in source) return source;
  const staging = join(root, "marketplaces", `.adding-${process.pid}-${Date.now()}`);
  try {
    const dir = await fetchMarketplace(source, staging, fetcher);
    const found = readMarketplace(dir);
    if (!found) return { error: "No marketplace.json found there." };
    const name = typeof found.data.name === "string" ? found.data.name : input;
    const id = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 64) || "marketplace";
    const state = readState(root);
    if (state.marketplaces.some((entry) => entry.id === id)) return { error: `A marketplace named “${id}” is already added.` };
    if (source.source !== "local") {
      rmSync(marketplaceDir(root, id), { recursive: true, force: true });
      cpSync(staging, marketplaceDir(root, id), { recursive: true });
    }
    const now = new Date().toISOString();
    const record: MarketplaceRecord = {
      id,
      name,
      ...(typeof found.data.description === "string" ? { description: found.data.description }
        : isRecord(found.data.metadata) && typeof found.data.metadata.description === "string"
          ? { description: found.data.metadata.description } : {}),
      source,
      addedAt: now,
      lastUpdated: now,
    };
    state.marketplaces.push(record);
    writeState(root, state);
    return record;
  } catch (error) {
    return { error: `Could not add the marketplace: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export async function refreshMarketplace(
  id: string,
  root: string = pluginsRoot(),
  fetcher: typeof fetch = fetch,
): Promise<MarketplaceRecord | { error: string }> {
  const state = readState(root);
  const record = state.marketplaces.find((entry) => entry.id === id);
  if (!record) return { error: "No such marketplace." };
  if (record.source.source !== "local") {
    const staging = join(root, "marketplaces", `.refresh-${process.pid}-${Date.now()}`);
    try {
      await fetchMarketplace(record.source, staging, fetcher);
      if (!readMarketplace(staging)) return { error: "The marketplace no longer has a marketplace.json." };
      rmSync(marketplaceDir(root, id), { recursive: true, force: true });
      cpSync(staging, marketplaceDir(root, id), { recursive: true });
    } catch (error) {
      return { error: `Could not refresh: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  record.lastUpdated = new Date().toISOString();
  writeState(root, state);
  return record;
}

export function removeMarketplace(id: string, root: string = pluginsRoot()): { removed: true } | { error: string } {
  const state = readState(root);
  if (!state.marketplaces.some((entry) => entry.id === id)) return { error: "No such marketplace." };
  if (state.installed.some((entry) => entry.marketplace === id)) {
    return { error: "Uninstall this marketplace's plugins first." };
  }
  state.marketplaces = state.marketplaces.filter((entry) => entry.id !== id);
  if (safeSegment(id)) rmSync(marketplaceDir(root, id), { recursive: true, force: true });
  writeState(root, state);
  return { removed: true };
}

type SourceKind = "path" | "github" | "git" | "git-subdir" | "zip";

function sourceKind(source: unknown): SourceKind | null {
  if (typeof source === "string") return source.startsWith("./") || source.startsWith("../") || !source.includes(":") ? "path" : null;
  if (!isRecord(source)) return null;
  if (source.source === "github" && typeof source.repo === "string") return "github";
  if (source.source === "git-subdir" && typeof source.url === "string") return "git-subdir";
  if (source.source === "url" && typeof source.url === "string") {
    return source.type === "zip" || /\.zip(\?.*)?$/i.test(source.url) ? "zip" : "git";
  }
  if (source.source === "git" && typeof source.url === "string") return "git";
  return null;
}

export function marketplaceCatalog(id: string, root: string = pluginsRoot()): CatalogEntry[] | { error: string } {
  const state = readState(root);
  const record = state.marketplaces.find((entry) => entry.id === id);
  if (!record) return { error: "No such marketplace." };
  const found = readMarketplace(marketplaceRoot(root, record));
  if (!found) return { error: "This marketplace's catalog is missing — refresh it." };
  const installed = new Set(state.installed.filter((entry) => entry.marketplace === id).map((entry) => entry.name));
  return (found.data.plugins as unknown[]).flatMap((plugin): CatalogEntry[] => {
    if (!isRecord(plugin) || typeof plugin.name !== "string") return [];
    const kind = sourceKind(plugin.source);
    return [{
      name: plugin.name,
      ...(typeof plugin.description === "string" ? { description: plugin.description } : {}),
      ...(typeof plugin.version === "string" ? { version: plugin.version } : {}),
      ...(typeof plugin.category === "string" ? { category: plugin.category } : {}),
      ...(isRecord(plugin.author) && typeof plugin.author.name === "string" ? { author: plugin.author.name } : {}),
      installable: !!kind && safeSegment(plugin.name) && !(kind === "path" && record.source.source === "url"),
      installed: installed.has(plugin.name),
    }];
  });
}

async function extractZip(file: string, into: string): Promise<void> {
  mkdirSync(into, { recursive: true });
  if (process.platform === "win32") {
    await run("powershell", ["-NoProfile", "-Command", "Expand-Archive", "-LiteralPath", file, "-DestinationPath", into, "-Force"], { timeout: GIT_TIMEOUT_MS });
  } else {
    await run("unzip", ["-q", "-o", file, "-d", into], { timeout: GIT_TIMEOUT_MS });
  }
}

/** Fetch one plugin's folder into `work`, returning the folder to copy. */
async function fetchPluginSource(
  source: unknown,
  marketplaceFolder: string,
  work: string,
  fetcher: typeof fetch,
): Promise<string> {
  const kind = sourceKind(source);
  if (kind === "path") {
    const dir = resolve(marketplaceFolder, source as string);
    if (!within(marketplaceFolder, dir)) throw new Error("The plugin's path leaves its marketplace.");
    return dir;
  }
  const spec = source as Record<string, unknown>;
  const ref = typeof spec.ref === "string" ? spec.ref : undefined;
  const sha = typeof spec.sha === "string" && /^[0-9a-f]{40}$/.test(spec.sha) ? spec.sha : undefined;
  const subdir = (base: string) => {
    if (typeof spec.path !== "string" || !spec.path) return base;
    const dir = resolve(base, spec.path);
    if (!within(base, dir)) throw new Error("The plugin's path leaves its repository.");
    return dir;
  };
  if (kind === "github") {
    await gitCheckout(`https://github.com/${spec.repo as string}.git`, join(work, "repo"), ref, sha);
    return subdir(join(work, "repo"));
  }
  if (kind === "git" || kind === "git-subdir") {
    await gitCheckout(spec.url as string, join(work, "repo"), ref, sha);
    return subdir(join(work, "repo"));
  }
  if (kind === "zip") {
    const response = await fetcher(spec.url as string, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`The plugin download answered ${response.status}.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const expected = typeof spec.sha256 === "string" ? spec.sha256.toLowerCase() : undefined;
    if (expected && createHash("sha256").update(bytes).digest("hex") !== expected) {
      throw new Error("The plugin download does not match its published checksum.");
    }
    writeFileSync(join(work, "plugin.zip"), bytes);
    await extractZip(join(work, "plugin.zip"), join(work, "unzipped"));
    const base = join(work, "unzipped");
    const dir = subdir(base);
    return existsSync(dir) ? dir : base;
  }
  throw new Error("This plugin's source type is not supported yet.");
}

export async function installPlugin(
  marketplace: string,
  name: string,
  root: string = pluginsRoot(),
  fetcher: typeof fetch = fetch,
): Promise<PluginListing | { error: string }> {
  if (!safeSegment(name)) return { error: "Invalid plugin name." };
  const state = readState(root);
  const record = state.marketplaces.find((entry) => entry.id === marketplace);
  if (!record || !safeSegment(record.id)) return { error: "No such marketplace." };
  if (state.installed.some((entry) => entry.marketplace === marketplace && entry.name === name)) {
    return { error: "That plugin is already installed." };
  }
  const folder = marketplaceRoot(root, record);
  const found = readMarketplace(folder);
  const entry = (found?.data.plugins as unknown[] | undefined)?.find((plugin) => isRecord(plugin) && plugin.name === name);
  if (!isRecord(entry)) return { error: "That plugin is not in this marketplace." };
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const work = mkdtempSync(join(tmpdir(), "omb-plugin-"));
  try {
    const source = await fetchPluginSource(entry.source, folder, work, fetcher);
    if (!existsSync(source)) throw new Error("The plugin's folder is missing from its source.");
    const contents = inspectPlugin(source, name);
    contentsCache.delete(source);
    const versionRaw = (typeof entry.version === "string" && entry.version) || contents?.version || "0.0.0";
    const version = safeSegment(versionRaw) ? versionRaw : "0.0.0";
    const installPath = join(root, "cache", record.id, name, version);
    rmSync(installPath, { recursive: true, force: true });
    mkdirSync(join(installPath, ".."), { recursive: true });
    cpSync(source, installPath, { recursive: true, filter: (path) => !/[\\/]\.git$/.test(path) });
    const next = readState(root);
    next.installed.push({ name, marketplace: record.id, version, installPath, installedAt: new Date().toISOString() });
    writeState(root, next);
    const listing = listPlugins(root).find((plugin) => plugin.key === pluginKey("omb", name, record.id));
    return listing ?? { error: "Installed, but the plugin could not be read back." };
  } catch (error) {
    return { error: `Could not install: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function uninstallPlugin(key: string, root: string = pluginsRoot()): { removed: true } | { error: string } {
  const state = readState(root);
  const index = state.installed.findIndex((entry) => pluginKey("omb", entry.name, entry.marketplace) === key);
  if (index < 0) return { error: "Only plugins installed here can be uninstalled here." };
  const [entry] = state.installed.splice(index, 1);
  delete state.access[key];
  if (entry && within(join(root, "cache"), entry.installPath)) rmSync(entry.installPath, { recursive: true, force: true });
  writeState(root, state);
  return { removed: true };
}
