// Optional semantic-memory provider behind markdown recall. OFF unless
// cfg.memoryProvider.enabled: with it off nothing here runs and recall is
// exactly what server/recall.ts always did. FTS5 + markdown recall are never
// replaced; a provider only ADDS hits, and any failure means markdown-only.
//
// The API key is never in settings the provider sees: `apiKeyRef` names an
// OMB_MEMORY_* environment variable (filled by config's syncCredentialEnv from
// the write-only `key`), and this module reads the value only when it builds
// an Authorization header.
import type { AppConfig } from "./config.ts";

export type MemoryProviderKind = "supermemory" | "serenity" | "generic-openai-embeddings";

export interface ProviderHit {
  text: string;
  /** Where the provider says the text came from (a document id, a file). */
  source: string;
  score: number;
}

export interface ProviderRecallOptions {
  limit: number;
  signal?: AbortSignal;
}

export interface MemoryProvider {
  name: string;
  recall(query: string, opts: ProviderRecallOptions): Promise<ProviderHit[]>;
}

export interface ProviderSettings {
  url: string;
  /** The key's value, resolved from `apiKeyRef`; empty when none is stored. */
  key: string;
  model: string;
}

export type ProviderFactory = (settings: ProviderSettings) => MemoryProvider;

/** A provider answers within this long, or recall goes on without it. */
export const PROVIDER_TIMEOUT_MS = 2_000;
export const DEFAULT_KEY_REF = "OMB_MEMORY_PROVIDER_KEY";
const KEY_REF = /^OMB_MEMORY_[A-Z0-9_]{1,48}$/;
const DEFAULT_MODEL = "text-embedding-3-small";
const MAX_HIT_CHARS = 2_000;

const registry = new Map<string, ProviderFactory>();

export function registerMemoryProvider(kind: string, factory: ProviderFactory): void {
  registry.set(kind, factory);
}

function authHeaders(key: string): Record<string, string> {
  return key ? { authorization: `Bearer ${key}` } : {};
}

function endpoint(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

async function postJson(url: string, key: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(key) },
    body: JSON.stringify(body),
    signal,
  });
  // The status is the whole story: a vendor's body never reaches a log or the UI.
  if (!res.ok) throw new Error(`memory provider answered ${res.status}`);
  return res.json();
}

/** An OpenAI-compatible embeddings endpoint plus a vector search beside it:
 *   POST {url}/embeddings  {model, input}                -> {data:[{embedding:number[]}]}
 *   POST {url}/search      {embedding, query, limit}     -> {results:[{text, source?, score?}]}
 * `url` is the user's own loopback or self-hosted server. */
export function genericOpenAiEmbeddings(settings: ProviderSettings): MemoryProvider {
  return {
    name: "embeddings",
    async recall(query, opts) {
      const embedded = (await postJson(endpoint(settings.url, "/embeddings"), settings.key, { model: settings.model, input: query }, opts.signal)) as {
        data?: Array<{ embedding?: unknown }>;
      };
      const embedding = embedded.data?.[0]?.embedding;
      if (!Array.isArray(embedding) || !embedding.every((n) => typeof n === "number")) throw new Error("memory provider returned no embedding");
      const found = (await postJson(endpoint(settings.url, "/search"), settings.key, { embedding, query, limit: opts.limit }, opts.signal)) as {
        results?: Array<{ text?: unknown; source?: unknown; score?: unknown }>;
      };
      const hits: ProviderHit[] = [];
      for (const row of Array.isArray(found.results) ? found.results : []) {
        if (typeof row?.text !== "string" || !row.text.trim()) continue;
        hits.push({
          text: row.text.trim().slice(0, MAX_HIT_CHARS),
          source: typeof row.source === "string" && row.source.trim() ? row.source.trim().slice(0, 120) : "memory",
          score: typeof row.score === "number" && Number.isFinite(row.score) ? row.score : 0,
        });
      }
      return hits.sort((a, b) => b.score - a.score).slice(0, opts.limit);
    },
  };
}

/** Documented placeholder for a vendor whose API this project does not
 * reverse-engineer. It refuses until URL and key are set, and even then has
 * no wire protocol to speak: wiring one is a deliberate follow-up. */
function stubAdapter(name: string): ProviderFactory {
  return (settings) => ({
    name,
    async recall() {
      if (!settings.url || !settings.key) throw new Error(`${name} memory provider is not configured`);
      throw new Error(`${name} adapter is a stub: no wire protocol implemented`);
    },
  });
}

registerMemoryProvider("generic-openai-embeddings", genericOpenAiEmbeddings);
registerMemoryProvider("supermemory", stubAdapter("supermemory"));
registerMemoryProvider("serenity", stubAdapter("serenity"));

/** The provider recall should consult, or null: disabled (the default), no
 * URL, or an unknown kind all mean markdown-only. */
export function resolveMemoryProvider(cfg: Pick<AppConfig, "memoryProvider">, env: NodeJS.ProcessEnv = process.env): MemoryProvider | null {
  const settings = cfg.memoryProvider;
  if (settings?.enabled !== true || !settings.kind || !settings.url?.trim()) return null;
  const factory = registry.get(settings.kind);
  if (!factory) return null;
  const ref = settings.apiKeyRef?.trim() || DEFAULT_KEY_REF;
  const key = KEY_REF.test(ref) ? env[ref]?.trim() ?? "" : "";
  return factory({ url: settings.url.trim(), key, model: settings.model?.trim() || DEFAULT_MODEL });
}

/** Provider hits within the deadline; [] on any failure. Never throws. */
export async function queryProvider(provider: MemoryProvider, query: string, limit: number, timeoutMs = PROVIDER_TIMEOUT_MS): Promise<ProviderHit[]> {
  const signal = AbortSignal.timeout(timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("memory provider timed out")), timeoutMs);
  });
  try {
    return await Promise.race([provider.recall(query, { limit, signal }), deadline]);
  } catch (err) {
    console.warn(`memory provider ${provider.name} skipped: ${err instanceof Error ? err.message : "failed"}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Describe settings for the UI: switches and configured-or-not, never the key. */
export function describeMemoryProvider(cfg: Pick<AppConfig, "memoryProvider">, env: NodeJS.ProcessEnv = process.env) {
  const settings = cfg.memoryProvider ?? {};
  const ref = settings.apiKeyRef?.trim() || DEFAULT_KEY_REF;
  return {
    enabled: settings.enabled === true,
    kind: settings.kind ?? "generic-openai-embeddings",
    url: settings.url ?? "",
    model: settings.model ?? "",
    apiKeyRef: ref,
    keyConfigured: KEY_REF.test(ref) && Boolean(env[ref]?.trim()),
  };
}
