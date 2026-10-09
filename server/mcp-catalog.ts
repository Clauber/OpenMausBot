import { readFileSync } from "node:fs";

import { z } from "zod";

import { MAX_MCP_SERVERS, mcpServerNameError, parseStoredMcpServer, type StoredMcpServer } from "./mcp-registry.ts";

/** One connector OpenMausBot can install on request. The catalog is what
 * ships in the repo, so it holds the NAMES of the secrets an entry needs and
 * where to look for them, never a value. Everything else (URL, command,
 * non-secret headers) is stored literally. */
export interface CatalogSecretSlot {
  /** where the value goes when the entry is installed */
  target: "header" | "env";
  /** the header or environment variable the server expects */
  name: string;
  /** a variable in the server's environment or a user env file that carries
   * the value; when it is absent the UI asks for the value once */
  envKey?: string;
}

export interface CatalogEntry {
  name: string;
  label: string;
  description: string;
  transport: "http" | "sse" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  env?: Record<string, string>;
  secrets: CatalogSecretSlot[];
}

/** Header and variable names that carry credentials. A value under one of
 * these is never copied out of a registry. */
const SECRET_NAME = /(key|token|secret|auth|password|passwd|cookie|credential|bearer)/i;
const SECRET_ARG = /(key|token|secret|password|passwd|bearer)/i;

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

export interface RegistryMeta {
  label?: string;
  description?: string;
}

export interface ParsedRegistry {
  entries: CatalogEntry[];
  skipped: Array<{ name: string; reason: string }>;
}

/** Build catalog entries from a servers registry shaped like
 * `{"mcpServers": {name: {type, url, headers} | {command, args, env}}}`.
 * Secret values are dropped: each secret header/variable becomes a slot.
 * `envKeyHints` maps `server/slot-name` to the variable that holds it. */
export function parseRegistry(
  raw: unknown,
  options: { meta?: Record<string, RegistryMeta>; envKeyHints?: Record<string, string> } = {},
): ParsedRegistry {
  const entries: CatalogEntry[] = [];
  const skipped: ParsedRegistry["skipped"] = [];
  const servers = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as { mcpServers?: unknown }).mcpServers
    : undefined;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return { entries, skipped: [{ name: "*", reason: "No mcpServers map found." }] };
  }
  for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
    const nameError = mcpServerNameError(name);
    if (nameError) { skipped.push({ name, reason: nameError }); continue; }
    if (!value || typeof value !== "object" || Array.isArray(value)) { skipped.push({ name, reason: "Not a server entry." }); continue; }
    const record = value as Record<string, unknown>;
    const meta = options.meta?.[name] ?? {};
    const slot = (target: CatalogSecretSlot["target"], slotName: string): CatalogSecretSlot => {
      const envKey = options.envKeyHints?.[`${name}/${slotName}`];
      return { target, name: slotName, ...(envKey ? { envKey } : {}) };
    };
    const common = { name, label: meta.label ?? name, description: meta.description ?? "" };
    if (typeof record.url === "string") {
      const headers: Record<string, string> = {};
      const secrets: CatalogSecretSlot[] = [];
      for (const [header, headerValue] of Object.entries((record.headers ?? {}) as Record<string, unknown>)) {
        if (typeof headerValue !== "string") continue;
        if (isSecretName(header)) secrets.push(slot("header", header));
        else headers[header] = headerValue;
      }
      entries.push({
        ...common,
        transport: record.type === "sse" ? "sse" : "http",
        url: record.url,
        ...(Object.keys(headers).length ? { headers } : {}),
        secrets,
      });
      continue;
    }
    if (typeof record.command === "string") {
      const args = Array.isArray(record.args) ? record.args.filter((arg): arg is string => typeof arg === "string") : [];
      if (args.some((arg) => SECRET_ARG.test(arg) && (arg.includes("=") || arg.startsWith("--")))) {
        skipped.push({ name, reason: "Arguments look like they carry a secret; pass it through an environment variable instead." });
        continue;
      }
      const env: Record<string, string> = {};
      const secrets: CatalogSecretSlot[] = [];
      for (const [variable, envValue] of Object.entries((record.env ?? {}) as Record<string, unknown>)) {
        if (typeof envValue !== "string") continue;
        if (isSecretName(variable)) secrets.push(slot("env", variable));
        else env[variable] = envValue;
      }
      entries.push({
        ...common,
        transport: "stdio",
        command: record.command,
        args,
        ...(Object.keys(env).length ? { env } : {}),
        secrets,
      });
      continue;
    }
    skipped.push({ name, reason: "Neither a url nor a command." });
  }
  return { entries, skipped };
}

/** Look a variable up in the process environment, then in the given
 * KEY=value files. Read one key at a time; values never leave this closure
 * except as the return value. */
export function createEnvLookup(files: readonly string[], env: NodeJS.ProcessEnv = process.env): (key: string) => string | undefined {
  return (key) => {
    const fromEnv = env[key];
    if (fromEnv) return fromEnv;
    for (const file of files) {
      let text: string;
      try { text = readFileSync(file, "utf8"); } catch { continue; }
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith(`${key}=`)) continue;
        const value = line.slice(key.length + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
        if (value) return value;
      }
    }
    return undefined;
  };
}

export type SecretResolution =
  | { ok: true; values: Record<string, string> }
  | { ok: false; missing: string[] };

/** A one-time value the person typed wins; otherwise the named variable. */
export function resolveCatalogSecrets(
  entry: CatalogEntry,
  provided: Record<string, string> | undefined,
  lookup: (key: string) => string | undefined,
): SecretResolution {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const secret of entry.secrets) {
    const value = provided?.[secret.name] || (secret.envKey ? lookup(secret.envKey) : undefined);
    if (value) values[secret.name] = value;
    else missing.push(secret.name);
  }
  return missing.length ? { ok: false, missing } : { ok: true, values };
}

/** The plain block Claude Code or Cursor would write for this entry. */
export function catalogStoredBlock(entry: CatalogEntry, secrets: Record<string, string>): Record<string, unknown> {
  if (entry.transport === "stdio") {
    const env: Record<string, string> = { ...entry.env };
    for (const slot of entry.secrets) if (slot.target === "env") env[slot.name] = secrets[slot.name]!;
    return { command: entry.command, args: entry.args ?? [], ...(Object.keys(env).length ? { env } : {}) };
  }
  const headers: Record<string, string> = { ...entry.headers };
  for (const slot of entry.secrets) if (slot.target === "header") headers[slot.name] = secrets[slot.name]!;
  return { type: entry.transport, url: entry.url, ...(Object.keys(headers).length ? { headers } : {}) };
}

export type CatalogInstall =
  | { ok: true; server: StoredMcpServer; next: Record<string, unknown>; alreadyStored: boolean }
  | { ok: false; status: number; error: string; missing?: string[] };

/** Make `entry` a normal enabled `mcpServers` entry. An already-stored
 * server is left exactly as it is (its own headers, its own switch); the
 * caller decides whether to turn it on. The result goes through the same
 * parser every stored entry does. */
export function installCatalogEntry(
  current: Record<string, unknown>,
  entry: CatalogEntry,
  options: { provided?: Record<string, string>; lookup: (key: string) => string | undefined },
): CatalogInstall {
  if (Object.hasOwn(current, entry.name)) {
    const stored = parseStoredMcpServer(entry.name, current[entry.name]);
    if (!stored.ok) return { ok: false, status: 400, error: stored.error };
    return { ok: true, server: stored.server, next: current, alreadyStored: true };
  }
  if (Object.keys(current).length >= MAX_MCP_SERVERS) {
    return { ok: false, status: 400, error: `You can add at most ${MAX_MCP_SERVERS} MCP servers.` };
  }
  const secrets = resolveCatalogSecrets(entry, options.provided, options.lookup);
  if (!secrets.ok) {
    return { ok: false, status: 422, error: `Needs a value for ${secrets.missing.join(", ")}.`, missing: secrets.missing };
  }
  const parsed = parseStoredMcpServer(entry.name, catalogStoredBlock(entry, secrets.values));
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
  const server: StoredMcpServer = { ...parsed.server, enabled: true };
  return { ok: true, server, next: { ...current, [entry.name]: server }, alreadyStored: false };
}

export interface CatalogListing {
  name: string;
  label: string;
  description: string;
  transport: CatalogEntry["transport"];
  /** where it connects: the URL, or the command */
  target: string;
  installed: boolean;
  enabled: boolean;
  /** names only: which secrets an install needs, and whether each is already
   * available to this server (never its value) */
  secrets: Array<{ name: string; envKey?: string; available: boolean }>;
}

export function listCatalog(
  entries: readonly CatalogEntry[],
  stored: Record<string, unknown> | undefined,
  lookup: (key: string) => string | undefined,
): CatalogListing[] {
  return entries.map((entry) => {
    const parsed = stored && Object.hasOwn(stored, entry.name) ? parseStoredMcpServer(entry.name, stored[entry.name]) : null;
    const server = parsed?.ok ? parsed.server : null;
    return {
      name: entry.name,
      label: entry.label,
      description: entry.description,
      transport: entry.transport,
      target: entry.url ?? entry.command ?? "",
      installed: server !== null,
      enabled: server?.enabled ?? false,
      secrets: entry.secrets.map((secret) => ({
        name: secret.name,
        ...(secret.envKey ? { envKey: secret.envKey } : {}),
        available: Boolean(secret.envKey && lookup(secret.envKey)),
      })),
    };
  });
}

const secretSlotSchema = z.object({
  target: z.enum(["header", "env"]),
  name: z.string().min(1).max(128),
  envKey: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
}).strict();

const userEntrySchema = z.object({
  name: z.string(),
  label: z.string().min(1).max(80).optional(),
  description: z.string().max(400).optional(),
  transport: z.enum(["http", "sse", "stdio"]),
  url: z.string().max(2_048).optional(),
  command: z.string().max(1_024).optional(),
  args: z.array(z.string().max(4_096)).max(64).optional(),
  headers: z.record(z.string(), z.string().max(16_384)).optional(),
  env: z.record(z.string(), z.string().max(16_384)).optional(),
  secrets: z.array(secretSlotSchema).max(32).default([]),
}).strict();

/** Entries the person added in `<data dir>/mcp-catalog.json`
 * (`{"entries": [...]}`, the shape of the built-in catalog). They add to or
 * replace built-in entries by name. Anything malformed, or carrying a
 * secret-named header or variable with a literal value, is skipped so a
 * pasted credential never lands in a catalog the UI lists. */
export function loadUserCatalog(file: string): CatalogEntry[] {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); } catch { return []; }
  const rows = parsed && typeof parsed === "object" ? (parsed as { entries?: unknown }).entries : undefined;
  if (!Array.isArray(rows)) return [];
  const entries: CatalogEntry[] = [];
  for (const row of rows) {
    const checked = userEntrySchema.safeParse(row);
    if (!checked.success || mcpServerNameError(checked.data.name)) continue;
    const entry = checked.data;
    const target = entry.transport === "stdio" ? entry.command : entry.url;
    if (!target) continue;
    const literals = Object.keys({ ...entry.headers, ...entry.env });
    if (literals.some(isSecretName)) continue;
    entries.push({ ...entry, label: entry.label ?? entry.name, description: entry.description ?? "" });
  }
  return entries;
}

export function mergeCatalogs(builtin: readonly CatalogEntry[], user: readonly CatalogEntry[]): CatalogEntry[] {
  const byName = new Map(builtin.map((entry) => [entry.name, entry] as const));
  for (const entry of user) byName.set(entry.name, entry);
  return [...byName.values()];
}
