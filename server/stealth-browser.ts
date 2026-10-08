// A bot's persistent browser as a headed stealth Chrome (stealth-browser/ in
// this repo). The service keeps one patchright Chrome per profile, with its
// fingerprint and evasions, and opens a fixed CDP port for it. agent-browser
// attaches to that port, so the bot's tools and the Browser panel drive the
// same window, and a person can click through a challenge the bot cannot.
const SESSION = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,95}$/;
const LAUNCH_TIMEOUT_MS = 20_000;
const RETRY_AFTER_FAILURE_MS = 30_000;

export class StealthBrowserError extends Error {}

/** Ask the service for this session's Chrome, launching it if needed, and
 * return the CDP address agent-browser should attach to. */
export async function stealthBrowserCdpUrl(baseUrl: string, session: string, options: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<string> {
  if (!SESSION.test(session) || session.includes("..")) throw new StealthBrowserError(`Invalid stealth browser profile name: ${session}`);
  const base = new URL(baseUrl);
  const bridge = new URL(`bridge/${encodeURIComponent(session)}`, base.href.endsWith("/") ? base : new URL(`${base.href}/`));
  bridge.searchParams.set("route", "direct");
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(bridge, { signal: AbortSignal.timeout(options.timeoutMs ?? LAUNCH_TIMEOUT_MS) });
  } catch (error) {
    throw new StealthBrowserError(`The stealth browser at ${base.origin} did not answer: ${(error as Error).message}`);
  }
  if (!response.ok) throw new StealthBrowserError(`The stealth browser at ${base.origin} could not open profile ${session} (HTTP ${response.status}).`);
  const body = await response.json().catch(() => null) as { cdpPort?: unknown } | null;
  const port = body?.cdpPort;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new StealthBrowserError(`The stealth browser at ${base.origin} returned no CDP port for profile ${session}.`);
  }
  // The service's Chrome listens beside the service itself.
  return `http://${base.hostname.includes(":") ? `[${base.hostname}]` : base.hostname}:${port}`;
}

/** Where each session's browser lives once stealth is configured. A session
 * stays on the address it first got: agent-browser refuses a client whose
 * launch settings change, so a service blip must not flip a working session
 * to the managed browser and back. Profile ports are fixed by the service, so
 * the remembered address stays right across its restarts. */
export class StealthAttachments {
  // Plain fields with explicit assignment: the harness runs under
  // --experimental-strip-types, which refuses accessibility modifiers on
  // fields and constructor parameter properties.
  private resolve: (base: string, session: string) => Promise<string>;
  private now: () => number;
  private readonly known = new Map<string, string>();
  private readonly failedAt = new Map<string, number>();

  constructor(resolve: (base: string, session: string) => Promise<string> = stealthBrowserCdpUrl, now: () => number = () => Date.now()) {
    this.resolve = resolve;
    this.now = now;
  }

  /** The CDP address, or null when this session has never reached the service. */
  async attachUrl(base: string, session: string, warn: (message: string) => void = console.warn): Promise<string | null> {
    const key = `${base} ${session}`;
    const failed = this.failedAt.get(key);
    if (failed !== undefined && this.now() - failed < RETRY_AFTER_FAILURE_MS) return this.known.get(key) ?? null;
    try {
      const url = await this.resolve(base, session);
      this.known.set(key, url);
      this.failedAt.delete(key);
      return url;
    } catch (error) {
      this.failedAt.set(key, this.now());
      warn(`stealth browser for ${session}: ${(error as Error).message}`);
      return this.known.get(key) ?? null;
    }
  }
}
