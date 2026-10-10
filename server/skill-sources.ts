// Skill sources: another machine's skill folders, mirrored read-only into a
// Legion-managed directory, walked into a catalog, and imported into the
// skills library. The mirror only ever READS the source: nothing here, and no
// path that reaches here, writes to a source tree. Skills are plain files and
// no credential file crosses: names that look like secrets are left behind,
// and skill text that embeds a secret-looking literal is held for review
// instead of being imported.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { installLibrarySkill, readSkillLibraryIndex, skillsLibraryRoot } from "./skill-library.ts";
import { isSkillName, parseSkillMd, scanSkillText, SKILL_FILE_MAX_BYTES, SKILL_NAME_MAX } from "../shared/skill-md.ts";

const MIRROR_MARKER = ".legion-skill-mirror";
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 10;
const MAX_SUPPORTING_LISTED = 50;

// ── file names that look like credentials ───────────────────────────────

/** Names that look like credential files. Documentation (`.md`) is exempt:
 * `token-usage.md` explains tokens; the content scan covers the rest. */
export function isSecretFileName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith(".md")) return false;
  if (/^\.env(\.|$)/.test(lower) || lower.endsWith(".env")) return true;
  if (/\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk)$/.test(lower)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(lower)) return true;
  const stem = lower.replace(/\.[a-z0-9]+$/, "");
  return /(^|[-_.])(credentials?|secrets?|tokens?|passwords?|passwd)([-_.]|$)/.test(stem);
}

// ── the mirror ──────────────────────────────────────────────────────────

export interface MirrorResult {
  copied: number;
  removed: number;
  excluded: Array<{ path: string; reason: string }>;
}

function sameBytes(a: string, b: Buffer): boolean {
  try { return readFileSync(a).equals(b); } catch { return false; }
}

/** Pull `from` into the mirror `to`. Pull-only: `from` is only listed and
 * read. `to` must be new, empty, or a previous mirror (marked), because files
 * the source dropped are removed from it. */
export function mirrorSkillTree(from: string, to: string, options: { maxFileBytes?: number } = {}): MirrorResult {
  const source = resolve(from);
  const target = resolve(to);
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  if (target === source || target.startsWith(source + sep)) throw new Error("the mirror cannot be inside the source");
  if (source.startsWith(target + sep)) throw new Error("the source cannot be inside the mirror");
  if (existsSync(target)) {
    const entries = readdirSync(target);
    if (entries.length > 0 && !entries.includes(MIRROR_MARKER)) throw new Error(`${target} is not a skill mirror, so it was not touched`);
  }
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, MIRROR_MARKER), "managed by Legion; safe to delete\n");

  const kept = new Set<string>();
  const excluded: MirrorResult["excluded"] = [];
  let copied = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, entry.name);
      const rel = relative(source, abs).split(sep).join("/");
      const info = lstatSync(abs);
      if (info.isSymbolicLink()) { excluded.push({ path: rel, reason: "a link, which could point outside the library" }); continue; }
      if (info.isDirectory()) {
        if (entry.name.startsWith(".")) continue;
        walk(abs, depth + 1);
        continue;
      }
      if (!info.isFile()) continue;
      if (isSecretFileName(entry.name)) { excluded.push({ path: rel, reason: "looks like a credential file" }); continue; }
      if (entry.name.startsWith(".")) continue;
      if (info.size > maxFileBytes) { excluded.push({ path: rel, reason: `larger than ${Math.round(maxFileBytes / 1024)} KB` }); continue; }
      const bytes = readFileSync(abs);
      const out = join(target, rel);
      if (!sameBytes(out, bytes)) {
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, bytes);
      }
      kept.add(rel);
      copied += 1;
    }
  };
  walk(source, 0);

  let removed = 0;
  const prune = (dir: string): boolean => {
    let empty = true;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(target, abs).split(sep).join("/");
      if (entry.isDirectory()) {
        if (prune(abs)) { rmSync(abs, { recursive: true, force: true }); } else empty = false;
      } else if (rel === MIRROR_MARKER || kept.has(rel)) {
        empty = false;
      } else {
        rmSync(abs, { force: true });
        removed += 1;
      }
    }
    return empty;
  };
  prune(target);
  return { copied, removed, excluded: excluded.sort((a, b) => a.path.localeCompare(b.path)) };
}

// ── conversion ──────────────────────────────────────────────────────────

const slugName = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, SKILL_NAME_MAX).replace(/-+$/g, "");
const unquote = (value: string) => value.trim().replace(/^["']|["']$/g, "").trim();

function firstParagraph(body: string): string {
  for (const block of body.split(/\r?\n\s*\r?\n/)) {
    const text = block.split(/\r?\n/).filter((line) => !/^\s*(#|```|---|\||>)/.test(line)).map((line) => line.trim()).filter(Boolean).join(" ");
    if (text) return text.slice(0, 300);
  }
  return "";
}

/** Bring a SKILL.md to the shape the library reads (name, description on one
 * line) without touching a skill that already has it. Anything else in the
 * frontmatter, platforms and the like, is left as written. */
export function normalizeSkillMd(text: string, fallbackName: string): { text: string; notes: string[] } {
  const notes: string[] = [];
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    const name = slugName(fallbackName);
    const description = firstParagraph(text) || name;
    return { text: `---\nname: ${name}\ndescription: ${description}\n---\n\n${text}`, notes: ["frontmatter added"] };
  }
  const lines = match[1]!.split(/\r?\n/);
  const out: string[] = [];
  let sawName = false;
  let sawDescription = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    const key = kv?.[1]?.toLowerCase();
    if (key === "name") {
      sawName = true;
      const raw = unquote(kv![2]!);
      if (isSkillName(raw)) { out.push(line); continue; }
      const slug = slugName(raw) || slugName(fallbackName);
      out.push(`name: ${slug}`);
      notes.push(`name rewritten to ${slug}`);
      continue;
    }
    if (key === "description") {
      const value = kv![2]!.trim();
      if (/^[|>][+-]?$/.test(value)) {
        const folded: string[] = [];
        while (i + 1 < lines.length && (/^[ \t]/.test(lines[i + 1]!) || lines[i + 1]!.trim() === "")) {
          i += 1;
          const piece = lines[i]!.trim();
          if (piece) folded.push(piece);
        }
        out.push(`description: ${folded.join(" ")}`);
        notes.push("description folded onto one line");
        sawDescription = folded.length > 0;
        continue;
      }
      sawDescription = unquote(value) !== "";
      out.push(line);
      continue;
    }
    out.push(line);
  }
  let body = match[2] ?? "";
  if (!sawName) {
    const slug = slugName(fallbackName);
    out.unshift(`name: ${slug}`);
    notes.push("name taken from the folder");
  }
  if (!sawDescription) {
    const description = firstParagraph(body);
    if (description) {
      const at = out.findIndex((line) => /^description:/i.test(line));
      if (at >= 0) out.splice(at, 1, `description: ${description}`); else out.push(`description: ${description}`);
      notes.push("description taken from the first paragraph");
    }
  }
  if (!notes.length) return { text, notes };
  body = body.startsWith("\n") || body === "" ? body : `\n${body}`;
  return { text: `---\n${out.join("\n")}\n---\n${body.startsWith("\n") ? body : `\n${body}`}`.replace(/\n\n\n+/, "\n\n"), notes };
}

// ── what a skill depends on ─────────────────────────────────────────────

const LUNA_ONLY_SKILLS = new Set(["hermes-themes", "hermes-desktop-plugins"]);
const LUNA_PATTERNS: Array<[RegExp, string]> = [
  [/\/home\/shado\b/, "a path under /home/shado (Luna)"],
  [/(?:~\/|\$HOME\/|\/)\.hermes\b|\bHERMES_HOME\b/, "the Hermes home directory"],
  [/^[ \t]*(?:\$ )?hermes[ \t]+[a-z][a-z-]*|`hermes[ \t]+[a-z][a-z-]+/m, "the hermes command"],
  [/\bluna\b/i, "Luna, the Hermes host"],
  [/\b10\.69\.42\.\d{1,3}\b/, "a service on the home network (10.69.42.x)"],
];

/** Reasons a skill only works where Hermes or Luna are. Reasons, never quotes. */
export function detectLunaDependence(name: string, text: string): string[] {
  const reasons: string[] = [];
  if (LUNA_ONLY_SKILLS.has(name)) reasons.push(`a Hermes-only skill (${name})`);
  for (const [pattern, reason] of LUNA_PATTERNS) if (pattern.test(text)) reasons.push(reason);
  return reasons;
}

// Placeholders are not secrets: <angle>, $VAR, ${VAR}, your-…, xxx, example…
const NOT_A_VALUE = String.raw`(?!<|\$|\{|your|xxx|\.\.\.|example|placeholder|changeme|\*\*\*|REDACTED)`;
const SECRET_PATTERNS: Array<[RegExp, string, ((match: string) => boolean)?]> = [
  [/\bsk-(?!x{6,}|X{6,}|\.{3})[A-Za-z0-9_-]{20,}/, "an API key (sk-…)"],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{24,}/, "a bearer token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, "a GitHub token"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [new RegExp(String.raw`(?:api[_-]?key|token|secret|password|passwd)["']?\s*[:=]\s*["']?${NOT_A_VALUE}([A-Za-z0-9/+_.-]{20,})`, "i"), "a key or token assigned a literal value", (value) => /\d/.test(value) && /[A-Za-z]/.test(value)],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key block"],
];

/** Kinds of secret-looking literal found in skill text. The text itself is
 * never returned: a finding names a kind so a person can go and look. */
export function detectSecretLiterals(text: string): string[] {
  const kinds: string[] = [];
  for (const [pattern, kind, accept] of SECRET_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    if (accept && !accept(match[1] ?? match[0])) continue;
    kinds.push(kind);
  }
  return kinds;
}

// ── the catalog ─────────────────────────────────────────────────────────

export interface SkillSourceDef { id: string; label: string }

export interface SourceSkill {
  name: string;
  description: string;
  source: string;
  /** folders above the skill, "" at the top level */
  category: string;
  categoryDescription?: string;
  /** the skill's folder inside its source */
  relPath: string;
  supportingFiles: string[];
  lunaDependent: string[];
  secretLiterals: string[];
  converted: string[];
  warnings: string[];
  /** the earlier source that already has a skill of this name */
  duplicateOf?: string;
  /** SKILL.md could not be read as a skill */
  error?: string;
}

export interface SkillSourceCatalog {
  root: string;
  sources: Array<SkillSourceDef & { count: number; present: boolean }>;
  skills: SourceSkill[];
}

function readFirstLine(file: string): string | undefined {
  try {
    const text = readFileSync(file, "utf8").split(/\r?\n/).map((line) => line.replace(/^#+\s*/, "").trim()).find(Boolean);
    return text ? text.slice(0, 200) : undefined;
  } catch { return undefined; }
}

function listSupporting(skillDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || existsSync(join(abs, "SKILL.md"))) continue;
        walk(abs, depth + 1);
      } else if (entry.isFile() && !(dir === skillDir && entry.name === "SKILL.md")) {
        out.push(relative(skillDir, abs).split(sep).join("/"));
      }
    }
  };
  walk(skillDir, 0);
  return out;
}

export function buildSkillSourceCatalog(root: string, defs: readonly SkillSourceDef[]): SkillSourceCatalog {
  const skills: SourceSkill[] = [];
  const sources: SkillSourceCatalog["sources"] = [];
  const firstSeen = new Map<string, string>();
  for (const def of defs) {
    const base = join(root, def.id);
    const present = existsSync(base);
    const found: SourceSkill[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > MAX_DEPTH) return;
      const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) found.push(readSourceSkill(base, dir, def.id));
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) walk(join(dir, entry.name), depth + 1);
      }
    };
    if (present) walk(base, 0);
    for (const skill of found) {
      const earlier = firstSeen.get(skill.name);
      if (earlier && !skill.error) skill.duplicateOf = earlier;
      else if (!skill.error) firstSeen.set(skill.name, def.id);
    }
    sources.push({ ...def, count: found.length, present });
    skills.push(...found);
  }
  return { root, sources, skills };
}

function readSourceSkill(base: string, dir: string, source: string): SourceSkill {
  const relPath = relative(base, dir).split(sep).join("/");
  const category = relPath.includes("/") ? dirname(relPath) : "";
  let categoryDescription: string | undefined;
  for (let at = category; at && at !== "."; at = dirname(at)) {
    categoryDescription = readFirstLine(join(base, at, "DESCRIPTION.md"));
    if (categoryDescription) break;
  }
  const folder = basename(dir);
  const raw = readFileSync(join(dir, "SKILL.md"), "utf8");
  const common = {
    source, category, relPath,
    ...(categoryDescription ? { categoryDescription } : {}),
    supportingFiles: listSupporting(dir).slice(0, MAX_SUPPORTING_LISTED),
  };
  if (Buffer.byteLength(raw, "utf8") > SKILL_FILE_MAX_BYTES) {
    return { name: slugName(folder) || folder, description: "", ...common, lunaDependent: [], secretLiterals: [], converted: [], warnings: [], error: `SKILL.md is larger than ${SKILL_FILE_MAX_BYTES / 1024}KB` };
  }
  const normalized = normalizeSkillMd(raw, folder);
  const parsed = parseSkillMd(normalized.text);
  if ("error" in parsed) {
    return { name: slugName(folder) || folder, description: "", ...common, lunaDependent: [], secretLiterals: [], converted: [], warnings: [], error: parsed.error };
  }
  return {
    name: parsed.name,
    description: parsed.description,
    ...common,
    lunaDependent: detectLunaDependence(parsed.name, normalized.text),
    secretLiterals: detectSecretLiterals(normalized.text),
    converted: normalized.notes,
    warnings: scanSkillText(normalized.text),
  };
}

// ── importing ───────────────────────────────────────────────────────────

export interface SkillImportOptions {
  /** everything the catalog lists */
  all?: boolean;
  /** just these skills, by name */
  names?: string[];
  /** Luna/Hermes-dependent skills the person chose to bring in anyway */
  include?: string[];
  /** skills with a secret-looking literal the person reviewed and accepts */
  reviewedSecrets?: string[];
}

export interface SkillImportResult {
  imported: string[];
  unchanged: string[];
  changed: string[];
  held: Array<{ name: string; source: string; reason: "lunaDependent" | "secretLiteral" }>;
  conflicts: Array<{ name: string; source: string; keptFrom: string }>;
  errors: Array<{ name: string; error: string }>;
}

const tagSlug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24).replace(/-+$/g, "");

/** Put catalog skills into the skills library. They land DISABLED like every
 * import: a person reads the SKILL.md and approves it. Skills that need
 * Hermes or Luna, or that embed a secret-looking literal, are held back
 * unless named. Reads SKILL.md from the mirror again (the catalog carries no
 * text, so a finding never travels with the literal it found). */
export function importSkillSources(
  catalog: SkillSourceCatalog,
  options: SkillImportOptions,
  libraryRoot: string = skillsLibraryRoot(),
): SkillImportResult {
  const result: SkillImportResult = { imported: [], unchanged: [], changed: [], held: [], conflicts: [], errors: [] };
  const wanted = options.names ? new Set(options.names) : null;
  const include = new Set(options.include ?? []);
  const reviewed = new Set(options.reviewedSecrets ?? []);
  const index = readSkillLibraryIndex(libraryRoot);
  for (const skill of catalog.skills) {
    if (!options.all && !wanted?.has(skill.name)) continue;
    if (skill.error) { result.errors.push({ name: skill.name, error: skill.error }); continue; }
    if (skill.duplicateOf) { result.conflicts.push({ name: skill.name, source: skill.source, keptFrom: skill.duplicateOf }); continue; }
    if (skill.secretLiterals.length && !reviewed.has(skill.name)) { result.held.push({ name: skill.name, source: skill.source, reason: "secretLiteral" }); continue; }
    if (skill.lunaDependent.length && !include.has(skill.name)) { result.held.push({ name: skill.name, source: skill.source, reason: "lunaDependent" }); continue; }
    const dir = join(catalog.root, skill.source, skill.relPath);
    const normalized = normalizeSkillMd(readFileSync(join(dir, "SKILL.md"), "utf8"), basename(dir));
    const existing = index[skill.name];
    if (existing) {
      const sha = createHash("sha256").update(normalized.text).digest("hex");
      (existing.sha256 === sha ? result.unchanged : result.changed).push(skill.name);
      continue;
    }
    const tags = [...new Set([skill.source, ...(skill.category ? [tagSlug(skill.category.split("/")[0]!)] : []), ...(skill.lunaDependent.length ? ["luna-only"] : [])].filter(Boolean))].slice(0, 8);
    const warnings = [
      ...scanSkillText(normalized.text),
      ...skill.converted.map((note) => `converted on import: ${note}`),
      ...(skill.lunaDependent.length ? [`Needs Hermes or Luna: ${skill.lunaDependent.join("; ")}`] : []),
      ...skill.secretLiterals.map((kind) => `may contain ${kind} — review before enabling`),
    ];
    const installed = installLibrarySkill({
      name: skill.name,
      instructions: normalized.text,
      source: `${skill.source}:${skill.relPath}`,
      tags,
      warnings,
      skippedFiles: skill.supportingFiles,
      reviewState: "disabled",
      root: libraryRoot,
    });
    if ("error" in installed) result.errors.push({ name: skill.name, error: installed.error });
    else result.imported.push(skill.name);
  }
  return result;
}
