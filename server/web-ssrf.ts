// SSRF guard for the web_fetch tool. A URL is only fetched when every address
// its host resolves to is public: loopback, private, link-local, CGNAT,
// multicast and reserved ranges are refused. The check and the connection use
// the same lookup, so a hostname cannot resolve to a public address for the
// check and a private one for the connect (DNS rebinding). Redirects are
// followed by hand and every hop is validated again.
import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

export const WEB_TIMEOUT_MS = 20_000;
export const WEB_BODY_MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/** A refusal the caller may show the model. `private` marks a target that
 * looked like a non-public host, which the route records in the decision log. */
export class WebFetchError extends Error {
  readonly code: "invalid-url" | "private" | "http" | "timeout" | "too-large" | "network";
  readonly host?: string;
  constructor(message: string, code: WebFetchError["code"], host?: string) {
    super(message);
    this.code = code;
    this.host = host;
  }
}

type LookupFn = typeof dnsLookup;
let lookupOverride: LookupFn | undefined;
let allowOverride: ((address: string) => boolean) | undefined;

/** Fixture servers only: the verification launcher (which also seals PATH)
 * may admit ONE extra loopback address, 127.0.0.2 or above, so a fake web
 * server can run while 127.0.0.1 and every private range stay refused. */
function fixtureAddress(): string | undefined {
  const host = process.env.OMB_TEST_WEB_FIXTURE_HOST;
  return host && process.env.OMB_TEST_SEALED_PATH === "1" && /^127\.0\.0\.(?:[2-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-4])$/.test(host) ? host : undefined;
}
const allowAddress = (address: string): boolean | undefined => allowOverride?.(address) || (fixtureAddress() === address ? true : undefined);
const fixtureActive = () => Boolean(allowOverride || fixtureAddress());

/** Test seam: fixtures resolve names themselves and may admit their own
 * loopback server. Never set outside tests and fixture scripts. */
export function setWebNetworkForTests(opts: { lookup?: LookupFn; allowAddress?: (address: string) => boolean } | null): void {
  lookupOverride = opts?.lookup;
  allowOverride = opts?.allowAddress;
}

function ipv4Private(a: number, b: number, c: number): boolean {
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113);
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return ipv4Private(a, b, c);
  }
  if (family === 6) {
    const v = address.toLowerCase();
    const mapped = v.match(/^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    const hex = v.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      return ipv4Private(hi >> 8, hi & 255, lo >> 8);
    }
    return v === "::" || v === "::1" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith("ff") || v.startsWith("2001:db8");
  }
  return true;
}

function refuse(host: string): WebFetchError {
  return new WebFetchError(`Refused: ${host} is not a public web address (private, loopback and link-local hosts cannot be fetched).`, "private", host);
}

/** A lookup that only ever hands the connection a public address. */
const guardedLookup = ((host: string, options: unknown, callback: unknown) => {
  const done = (typeof options === "function" ? options : callback) as (err: Error | null, address?: unknown, family?: number) => void;
  const opts = typeof options === "function" ? {} : (options as { all?: boolean });
  (lookupOverride ?? dnsLookup)(host, { all: true }, ((err: Error | null, addresses: Array<{ address: string; family: number }>) => {
    if (err) return done(err);
    const allowed = (a: string) => !isPrivateAddress(a) || allowAddress(a) === true;
    if (!addresses.length || !addresses.every((a) => allowed(a.address))) return done(refuse(host));
    if (opts.all) return done(null, addresses);
    done(null, addresses[0].address, addresses[0].family);
  }) as never);
}) as unknown as typeof dnsLookup;

/** Reject what can be rejected before any DNS or socket work. */
export function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebFetchError("That is not a valid URL.", "invalid-url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebFetchError("Only http and https URLs can be fetched.", "invalid-url");
  }
  if (url.username || url.password) throw new WebFetchError("URLs with embedded credentials are not fetched.", "invalid-url");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && isPrivateAddress(host) && allowAddress(host) !== true) throw refuse(host);
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host) && !fixtureActive()) throw refuse(host);
  return url;
}

export interface GuardedResponse {
  status: number;
  url: string;
  contentType: string;
  body: Buffer;
}

function once(url: URL): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(url, {
      method: "GET",
      lookup: guardedLookup,
      timeout: WEB_TIMEOUT_MS,
      headers: { "user-agent": "Mozilla/5.0 (compatible; OpenMausBot/1.0)", accept: "text/html,text/plain,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5" },
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > WEB_BODY_MAX_BYTES) {
          req.destroy(new WebFetchError(`The response is larger than ${WEB_BODY_MAX_BYTES / 1024 / 1024} MB.`, "too-large"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new WebFetchError("The request timed out after 20 seconds.", "timeout")));
    req.on("error", (err) => reject(err instanceof WebFetchError ? err
      : new WebFetchError(`Could not reach ${url.hostname}: ${err.message}`, "network", url.hostname)));
    req.end();
  });
}

/** GET with SSRF guards, a 20 s timeout, a 2 MB body cap and re-validated redirects. */
export async function guardedGet(raw: string): Promise<GuardedResponse> {
  let url = assertFetchableUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await once(url);
    const location = res.headers.location;
    if (res.status >= 300 && res.status < 400 && location) {
      url = assertFetchableUrl(new URL(location, url).toString());
      continue;
    }
    if (res.status >= 400) throw new WebFetchError(`The site answered HTTP ${res.status}.`, "http", url.hostname);
    return { status: res.status, url: url.toString(), contentType: String(res.headers["content-type"] ?? ""), body: res.body };
  }
  throw new WebFetchError("Too many redirects.", "network");
}
