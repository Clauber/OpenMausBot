// web_fetch and web_search, run by the harness for a bot's agents tools.
// web_fetch is SSRF-guarded (web-ssrf.ts) and cached per URL for ten minutes.
// web_search is provider-pluggable: the keyless "duckduckgo-html" default, or
// a JSON search API named by cfg.webSearch (the key is read only through
// `apiKeyRef`, an OMB_WEBSEARCH_* environment variable that syncCredentialEnv fills).
import type { AppConfig } from "./config.ts";
import { guardedGet, WebFetchError, WEB_TIMEOUT_MS } from "./web-ssrf.ts";

export const WEB_TEXT_MAX_CHARS = 30_000;
export const WEB_CACHE_TTL_MS = 10 * 60_000;
export const WEB_SEARCH_MAX_RESULTS = 8;
const CACHE_MAX_ENTRIES = 100;

export interface WebFetchResult {
  url: string;
  title?: string;
  text: string;
  truncated: boolean;
  cached: boolean;
}

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

/** Readable text from HTML: scripts, styles and tags go; block ends become line breaks. */
export function htmlToText(html: string): { title?: string; text: string } {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const body = html
    .replace(/<(script|style|noscript|svg|head|title)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  const text = decodeEntities(body)
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const cleanTitle = title ? decodeEntities(title.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim() : "";
  return { ...(cleanTitle ? { title: cleanTitle } : {}), text };
}

const cache = new Map<string, { at: number; result: Omit<WebFetchResult, "cached"> }>();

export function clearWebCache(): void {
  cache.clear();
}

export async function webFetch(rawUrl: string, now = Date.now()): Promise<WebFetchResult> {
  const hit = cache.get(rawUrl);
  if (hit && now - hit.at < WEB_CACHE_TTL_MS) return { ...hit.result, cached: true };
  const res = await guardedGet(rawUrl);
  const type = res.contentType.toLowerCase();
  if (type && !/^(text\/|application\/(xhtml\+xml|json|xml))/.test(type)) {
    throw new WebFetchError(`That URL is ${res.contentType.split(";")[0]}, not readable text.`, "http");
  }
  const raw = res.body.toString("utf8");
  const parsed = /html|xml/.test(type) || /^\s*<(!doctype|html)/i.test(raw) ? htmlToText(raw) : { text: raw.trim() };
  const truncated = parsed.text.length > WEB_TEXT_MAX_CHARS;
  const result = {
    url: res.url,
    ...(parsed.title ? { title: parsed.title } : {}),
    text: truncated ? parsed.text.slice(0, WEB_TEXT_MAX_CHARS) : parsed.text,
    truncated,
  };
  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  cache.set(rawUrl, { at: now, result });
  return { ...result, cached: false };
}

const DDG_ENDPOINT = "https://html.duckduckgo.com/html/";

/** DuckDuckGo wraps result links as //duckduckgo.com/l/?uddg=<encoded target>. */
function unwrapDuckLink(href: string): string {
  const decoded = decodeEntities(href);
  try {
    const url = new URL(decoded, DDG_ENDPOINT);
    const target = url.searchParams.get("uddg");
    return target ?? url.toString();
  } catch {
    return decoded;
  }
}

export function parseDuckDuckGoHtml(html: string, limit = WEB_SEARCH_MAX_RESULTS): WebSearchHit[] {
  const hits: WebSearchHit[] = [];
  const link = /<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  for (let m = link.exec(html); m && hits.length < limit; m = link.exec(html)) {
    const href = m[0].match(/href="([^"]*)"/i)?.[1];
    if (!href) continue;
    const url = unwrapDuckLink(href);
    if (!/^https?:\/\//i.test(url)) continue;
    // The snippet is the next result__snippet before the following result link.
    const rest = html.slice(m.index + m[0].length);
    const next = rest.search(/class="[^"]*\bresult__a\b/i);
    const scope = next < 0 ? rest : rest.slice(0, next);
    const snippet = scope.match(/class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/i)?.[1] ?? "";
    hits.push({
      title: decodeEntities(m[1].replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim(),
      url,
      snippet: decodeEntities(snippet.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim(),
    });
  }
  return hits;
}

type SearchCfg = Pick<AppConfig, "webSearch">;

async function fetchSearch(url: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(WEB_TIMEOUT_MS), redirect: "follow" });
  // The status is the whole story: a vendor's body never reaches the model.
  if (!res.ok) throw new WebFetchError(`The search provider answered HTTP ${res.status}.`, "http");
  return res;
}

/** The search endpoint is the operator's configured provider, so it is not
 * SSRF-filtered; pages a result points at are only read through web_fetch. */
export async function webSearch(query: string, cfg: SearchCfg): Promise<WebSearchHit[]> {
  const q = query.trim();
  if (!q) throw new WebFetchError("A search query is required.", "invalid-url");
  const settings = cfg.webSearch ?? {};
  const provider = settings.provider ?? "duckduckgo-html";
  if (provider === "duckduckgo-html") {
    const res = await fetchSearch(settings.url || DDG_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "Mozilla/5.0 (compatible; OpenMausBot/1.0)" },
      body: new URLSearchParams({ q }).toString(),
    });
    return parseDuckDuckGoHtml(await res.text());
  }
  // json-api: GET {url}?q=..., bearer key from apiKeyRef, results:[{title,url,snippet}].
  if (!settings.url) throw new WebFetchError("The search provider has no address configured.", "network");
  const ref = settings.apiKeyRef && /^OMB_WEBSEARCH_[A-Z0-9_]{1,48}$/.test(settings.apiKeyRef) ? settings.apiKeyRef : undefined;
  const key = ref ? process.env[ref] ?? "" : "";
  const target = new URL(settings.url);
  target.searchParams.set("q", q);
  const res = await fetchSearch(target.toString(), { headers: key ? { authorization: `Bearer ${key}` } : {} });
  const body = (await res.json()) as { results?: Array<{ title?: unknown; url?: unknown; snippet?: unknown }> };
  return (body.results ?? [])
    .filter((r) => typeof r.url === "string" && /^https?:\/\//i.test(r.url))
    .slice(0, WEB_SEARCH_MAX_RESULTS)
    .map((r) => ({ title: String(r.title ?? ""), url: String(r.url), snippet: String(r.snippet ?? "") }));
}
