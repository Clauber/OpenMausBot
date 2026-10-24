// Codex-subscription Live calls: the ChatGPT/Codex app's own voice call as the
// voice, paid for by the sign-in the Codex CLI already manages on this
// computer (live probes 2026-10-07: POST
// chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas
// with the auth.json Bearer token, model gpt-live-1-codex and delegation
// {type:"client"} answers a WebRTC offer; the call's data channel then speaks
// the V3 quicksilver events — input_transcript.added, output_transcript.added,
// delegation.created — and a delegation.context.append makes the voice speak a
// backend result).
//
// LiveCallController speaks the GPT-Live sessions dialect over a server-side
// WebSocket. A V3 call has no such socket: the browser holds the one data
// channel, and audio rides RTP. This file therefore owns two things:
//
//   createCodexLiveSession — exchanges the renderer's offer for a V3 session
//     server-side, so the credential never reaches the browser.
//
//   the relay facade — a LiveSocket the controller can attach to, backed by
//     the browser's data channel. The renderer pipes raw data-channel frames
//     up (POST /api/live/call/relay) and writes frames down (the SSE stream
//     the same routes serve) into that channel. The controller sees exactly
//     the dialect it knows; the browser stays an untrusted pipe that can hang
//     up and carry media, but decides nothing: every dispatch, approval and
//     spoken result still happens here.
//
// The token is read from ~/.codex/auth.json per call (OMB_CODEX_AUTH_FILE
// overrides the path). Unlike the Codex CLI's own client, a long-lived call
// cannot wait for the next `codex` run to refresh it, so an expiring token is
// refreshed against auth.openai.com and written back before it can fail
// mid-call; the refresh token never leaves the process. The upstream
// endpoints are overridable with OMB_CODEX_LIVE_URL and OMB_CODEX_OAUTH_URL
// (loopback only, for tests and the fixture). No error message or log line
// ever carries the token.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { LiveSessionError, type LiveBot } from "./live-call.ts";
import type { LiveSocket } from "./live-call-controller.ts";

export const CODEX_LIVE_MODEL = "gpt-live-1-codex";
/** The gpt-live (V3) voices the probes saw accepted; V2 names (marin, cedar…)
 * fall back to the default rather than failing the call as a 403 that looks
 * like an entitlement problem. */
export const CODEX_LIVE_VOICES: ReadonlyArray<string> = [
  "cove", "juniper", "maple", "spruce", "ember", "vale", "breeze", "arbor", "sol",
];
export const DEFAULT_CODEX_VOICE = "cove";
/** The controller requires a non-empty key before starting; when the codex
 * engine is selected the credential comes from auth.json instead, so the
 * harness hands the controller this sentinel. */
export const CODEX_KEY_SENTINEL = "codex";
/** The Codex CLI's public OAuth client id, as the signed-in token names it.
 * Refreshing through it keeps the CLI's own grant valid. */
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
/** Refresh this far before expiry, so a call never starts on a token that
 * dies under it. */
const REFRESH_SKEW_MS = 5 * 60_000;
const REFRESH_TIMEOUT_MS = 10_000;
const CREATE_TIMEOUT_MS = 20_000;
/** How long a read of auth.json is trusted before the disk is consulted again. */
const AUTH_CACHE_MS = 5_000;
/** The largest data-channel frame the relay accepts from the browser. */
const MAX_EVENT_CHARS = 32_768;
interface QueuedFrame {
  encoded: string;
  frame: Record<string, unknown>;
  /** The spoken text of a delegation result, for delivery confirmation. */
  text: string;
}

/** Appends held while the browser's relay stream is on its way. */
const MAX_QUEUED_FRAMES = 200;
/** Frames held while the voice's own turn is open. */
const MAX_HELD_FRAMES = 100;
/** A turn that stays open this long (interrupted, or its done was lost to a
 * context rollover) stops holding results. */
const HOLD_DEADLINE_MS = 8_000;
/** Comment frames on an idle relay stream, so nothing in between closes it. */
const RELAY_HEARTBEAT_MS = 15_000;

// ── the credential ──────────────────────────────────────────────────────

export function codexAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OMB_CODEX_AUTH_FILE?.trim();
  return override || join(homedir(), ".codex", "auth.json");
}

export interface CodexAuth {
  token: string;
  accountId: string;
  /** Empty when the sign-in predates refresh tokens: usable, but only until
   * the access token expires. */
  refreshToken: string;
  /** From the JWT exp claim; null when unreadable (treated as unexpired). */
  expiresAt: number | null;
}

/** Parses auth.json's shape without trusting its contents beyond the fields
 * the realtime endpoint needs. Returns null for any other auth mode. */
export function parseCodexAuth(raw: string): CodexAuth | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const auth = parsed as { tokens?: { access_token?: unknown; account_id?: unknown; refresh_token?: unknown } };
  const token = auth.tokens?.access_token;
  const accountId = auth.tokens?.account_id;
  if (typeof token !== "string" || !token.trim() || typeof accountId !== "string" || !accountId.trim()) return null;
  let expiresAt: number | null = null;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown };
    if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) expiresAt = payload.exp * 1_000;
  } catch {
    // an opaque token still works; OpenAI decides
  }
  return {
    token: token.trim(),
    accountId: accountId.trim(),
    refreshToken: typeof auth.tokens?.refresh_token === "string" ? auth.tokens.refresh_token : "",
    expiresAt,
  };
}

export interface CodexCredentialIo {
  readRaw(path: string): string;
  writeRaw(path: string, raw: string): void;
  mtimeMs(path: string): number;
}

const defaultIo: CodexCredentialIo = {
  readRaw: (path) => readFileSync(path, "utf8"),
  writeRaw: (path, raw) => writeFileAtomic(path, raw),
  mtimeMs: (path) => statSync(path).mtimeMs,
};

export interface CodexCredentials {
  /** What the sign-in file holds right now (expired or not). */
  read(env?: NodeJS.ProcessEnv): CodexAuth | null;
  /** A sign-in exists that a call can use — valid now, or refreshable. */
  configured(env?: NodeJS.ProcessEnv): boolean;
  /** A token fit for starting a call: refreshes first when it expires soon
   * or when `force` says the provider just refused it. Null: nothing usable. */
  fresh(options?: { force?: boolean; env?: NodeJS.ProcessEnv }): Promise<CodexAuth | null>;
}

export function createCodexCredentials(options: {
  io?: Partial<CodexCredentialIo>;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?(): number;
} = {}): CodexCredentials {
  const io: CodexCredentialIo = { ...defaultIo, ...options.io };
  const fetchImpl = options.fetchImpl ?? fetch;
  const envOf = (env?: NodeJS.ProcessEnv) => env ?? options.env ?? process.env;
  const now = options.now ?? Date.now;
  interface Cache { path: string; mtimeMs: number; readAt: number; auth: CodexAuth | null; raw: string }
  let cache: Cache | null = null;
  let inflight: Promise<CodexAuth | null> | null = null;

  const read = (env?: NodeJS.ProcessEnv): CodexAuth | null => {
    const path = codexAuthPath(envOf(env));
    try {
      const mtimeMs = io.mtimeMs(path);
      if (cache && cache.path === path && cache.mtimeMs === mtimeMs && now() - cache.readAt < AUTH_CACHE_MS) return cache.auth;
      const raw = io.readRaw(path);
      const auth = parseCodexAuth(raw);
      cache = { path, mtimeMs, readAt: now(), auth, raw };
      return auth;
    } catch {
      cache = null;
      return null;
    }
  };

  const hardExpired = (auth: CodexAuth) => auth.expiresAt !== null && auth.expiresAt <= now();
  /** Past the refresh window but still accepted — the honest fallback when a
   * refresh itself fails. */
  const stillValid = (auth: CodexAuth) => auth.expiresAt === null || auth.expiresAt > now();

  const refresh = async (auth: CodexAuth, env?: NodeJS.ProcessEnv): Promise<CodexAuth | null> => {
    if (!auth.refreshToken) return null;
    let response: Response;
    try {
      response = await fetchImpl(`${codexOAuthBaseUrl(envOf(env))}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: "refresh_token", refresh_token: auth.refreshToken, client_id: CODEX_OAUTH_CLIENT_ID }),
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null) as { access_token?: unknown; refresh_token?: unknown } | null;
    if (typeof payload?.access_token !== "string" || !payload.access_token.trim()) return null;
    const next = parseCodexAuth(JSON.stringify({ tokens: {
      access_token: payload.access_token,
      account_id: auth.accountId,
      refresh_token: typeof payload.refresh_token === "string" && payload.refresh_token ? payload.refresh_token : auth.refreshToken,
    } }));
    return next;
  };

  /** Puts a refreshed token back into auth.json, so the Codex CLI keeps one
   * grant instead of fighting this file. Skipped when the file changed since
   * we read it — whoever touched it refreshed more recently than we did. */
  const writeBack = (auth: CodexAuth) => {
    if (!cache) return;
    try {
      if (io.mtimeMs(cache.path) !== cache.mtimeMs) return;
      const parsed = JSON.parse(cache.raw) as { tokens?: Record<string, unknown>; last_refresh?: unknown };
      if (!parsed.tokens) return;
      parsed.tokens.access_token = auth.token;
      if (auth.refreshToken) parsed.tokens.refresh_token = auth.refreshToken;
      parsed.last_refresh = new Date().toISOString();
      io.writeRaw(cache.path, JSON.stringify(parsed, null, 2));
      cache = { ...cache, mtimeMs: io.mtimeMs(cache.path), readAt: now(), auth, raw: JSON.stringify(parsed, null, 2) };
    } catch {
      // The call keeps the fresh token in memory either way.
    }
  };

  const fresh = (callOptions: { force?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<CodexAuth | null> => {
    const run = (async () => {
      let auth = read(callOptions.env);
      if (!auth) return null;
      if (!callOptions.force && !hardExpired(auth) && (auth.expiresAt === null || auth.expiresAt - now() > REFRESH_SKEW_MS)) return auth;
      if (hardExpired(auth) && !auth.refreshToken) return null;
      const next = await refresh(auth, callOptions.env);
      if (next) {
        writeBack(next);
        return next;
      }
      return stillValid(auth) ? auth : null;
    })();
    if (!callOptions.force) {
      inflight = run.finally(() => { if (inflight === run) inflight = null; });
    }
    return run;
  };

  return {
    read,
    configured: (env) => {
      const auth = read(env);
      return auth !== null && (Boolean(auth.refreshToken) || stillValid(auth));
    },
    fresh: (callOptions = {}) => {
      if (!callOptions.force && inflight) return inflight;
      return fresh(callOptions);
    },
  };
}

/** The instance the harness and the settings surface share. */
export const codexCredentials = createCodexCredentials();

export function codexLiveConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return codexCredentials.configured(env);
}

// ── endpoints ───────────────────────────────────────────────────────────

export function codexLiveBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  // Tests and the fixture point this at a loopback fake, exactly like
  // liveBaseUrl; anything else is ignored.
  const override = env.OMB_CODEX_LIVE_URL?.trim() ?? "";
  return /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(override) ? override : "https://chatgpt.com";
}

export function codexOAuthBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OMB_CODEX_OAUTH_URL?.trim() ?? "";
  return /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(override) ? override : "https://auth.openai.com";
}

export function codexCallsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${codexLiveBaseUrl(env)}/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas`;
}

export function codexLiveVoice(voice: string | undefined): string {
  const name = voice?.trim().toLowerCase() ?? "";
  return CODEX_LIVE_VOICES.includes(name) ? name : DEFAULT_CODEX_VOICE;
}

/** Compact voice instructions for the V3 session. The full GPT-Live prompt
 * (~2.5 KB) rolled the session's context window over within a minute, which
 * drops delegation items — and their results — out of the model's reach
 * (seen live, 2026-10-08). The codex voice needs far less: delegation is the
 * session's own protocol, not a behavior to be explained. */
export function codexLiveInstructions(bot: LiveBot): string {
  const name = bot.name.replace(/\s+/g, " ").trim().slice(0, 60) || "the agent";
  const title = (bot.title ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  return [
    `You speak for ${name}${title ? `, ${title}` : ""} — an agent that runs in OpenMausBot on the user's computer. Speak as ${name} in the first person; never mention a voice layer or a backend.`,
    "Keep replies to one short sentence. Match the user's language.",
    "When the user asks a question, gives an instruction, answers a question you asked, or says yes or no to a permission request, delegate it: delegate before answering, and say briefly that you are checking. Do not delegate greetings or small talk, and never answer from your own knowledge anything that needs the backend.",
    "Results arrive for your delegations. When one arrives, speak it in your own words. Never invent a result, and never say an action happened before its result arrives.",
    "Status notes arrive while work runs; if asked, answer from the latest note in one sentence.",
  ].join("\n");
}

// ── session creation ────────────────────────────────────────────────────

export interface CreateCodexLiveSessionInput {
  sdp: string;
  bot: LiveBot;
  voice?: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  credentials?: CodexCredentials;
  timeoutMs?: number;
}

/** Exchanges the renderer's WebRTC offer for a V3 (gpt-live-1-codex) call,
 * authenticated by the ChatGPT sign-in. The session config rides the create
 * request exactly as the probes proved it; the credential never reaches the
 * renderer. Errors carry a status and a message fit for the user — never the
 * token, never OpenAI's raw body. */
export async function createCodexLiveSession(input: CreateCodexLiveSessionInput): Promise<{ sessionId: string; sdp: string }> {
  const env = input.env ?? process.env;
  const credentials = input.credentials ?? codexCredentials;
  const auth = await credentials.fresh({ env });
  if (!auth) {
    throw new LiveSessionError(
      "The ChatGPT sign-in for voice is missing or has expired and could not be refreshed. Open Codex and make sure you are signed in.",
      400,
    );
  }
  if (!input.sdp.trim()) {
    throw new LiveSessionError("The call could not start: the connection offer was invalid.", 400);
  }
  const body = JSON.stringify({
    sdp: input.sdp,
    session: {
      model: CODEX_LIVE_MODEL,
      instructions: codexLiveInstructions(input.bot),
      audio: { output: { voice: codexLiveVoice(input.voice) } },
      // "client" delegation: the model hands every real request back over the
      // data channel, where the controller turns it into a turn on the bot
      delegation: { type: "client" },
    },
  });
  const attempt = (token: string): Promise<Response> =>
    (input.fetchImpl ?? fetch)(codexCallsUrl(env), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "chatgpt-account-id": auth.accountId,
        // the query params are mandatory whenever openai-alpha is sent
        "openai-alpha": "quicksilver=v2",
        "content-type": "application/json",
        originator: "openmausbot",
        "user-agent": "openmausbot (live call)",
      },
      body,
      signal: AbortSignal.timeout(input.timeoutMs ?? CREATE_TIMEOUT_MS),
    });
  const send = async (token: string): Promise<Response> => {
    try {
      return await attempt(token);
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new LiveSessionError(
        timedOut ? "OpenAI did not answer in time. Try the call again." : "Could not reach OpenAI. Check the internet connection.",
        502,
      );
    }
  };
  let response = await send(auth.token);
  if (response.status === 401) {
    // The token died early (revoked server-side, clock skew): one refresh and
    // one retry. A 403 is an entitlement problem; retrying cannot help.
    const next = await credentials.fresh({ env, force: true });
    if (next) response = await send(next.token);
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new LiveSessionError("OpenAI rejected the ChatGPT sign-in for voice. Open Codex and make sure voice mode works there.", 401);
    }
    throw new LiveSessionError(
      response.status === 429
        ? "OpenAI is limiting voice sessions right now. Try again in a moment."
        : `OpenAI could not start the call (HTTP ${response.status}).`,
      response.status === 429 ? 429 : 502,
    );
  }
  const sdp = await response.text().catch(() => "");
  const callId = response.headers.get("location")?.split("?")[0]?.split("/").filter(Boolean).pop() ?? "";
  if (!sdp.trim() || !/^[\w-]{1,200}$/.test(callId)) {
    throw new LiveSessionError("OpenAI returned an unexpected answer. Try the call again.", 502);
  }
  return { sessionId: callId, sdp };
}

// ── the protocol adapter ────────────────────────────────────────────────

/** Translates one raw V3 data-channel event into the controller's dialect,
 * appending zero or more controller events. Turn bookkeeping, append
 * acknowledgements and anything unrecognized translates to nothing: the
 * controller's view of the call is built from transcripts, delegations,
 * usage, errors and the close. */
export function toControllerEvents(event: unknown, out: Array<Record<string, unknown>>): void {
  if (!event || typeof event !== "object" || Array.isArray(event)) return;
  const v3 = event as Record<string, unknown>;
  switch (v3.type) {
    case "session.started": {
      const session = v3.session as { id?: unknown } | undefined;
      out.push({ type: "session.started", ...(typeof session?.id === "string" ? { session: { id: session.id } } : {}) });
      return;
    }
    case "input_transcript.added":
    case "output_transcript.added": {
      const item = v3.item as { text?: unknown } | undefined;
      const text = typeof item?.text === "string" ? item.text : "";
      if (!text) return;
      const startMs = Number(v3.start_ms);
      const endMs = Number(v3.end_ms);
      out.push({
        type: v3.type === "input_transcript.added" ? "session.input_transcript.delta" : "session.output_transcript.delta",
        delta: text,
        start_ms: Number.isFinite(startMs) ? startMs : 0,
        end_ms: Number.isFinite(endMs) ? endMs : 0,
      });
      return;
    }
    case "delegation.created": {
      const item = v3.item as { id?: unknown; target?: unknown } | undefined;
      if (item?.target !== "client" || typeof item.id !== "string" || !item.id) return;
      const offsetMs = Number(v3.offset_ms);
      out.push({
        type: "session.delegation.created",
        delegation: { id: item.id, target: "client" },
        offset_ms: Number.isFinite(offsetMs) ? offsetMs : 0,
      });
      return;
    }
    case "session.usage.updated": {
      const usage = v3.usage as { audio_duration_ms?: unknown } | undefined;
      const ms = Number(usage?.audio_duration_ms);
      if (!Number.isFinite(ms) || ms < 0) return;
      out.push({ type: "session.usage.updated", usage: { seconds: Math.round(ms) / 1000 } });
      return;
    }
    case "error": {
      const error = v3.error as { code?: unknown; message?: unknown } | undefined;
      const code = typeof error?.code === "string" && error.code
        ? error.code
        : typeof error?.message === "string" && error.message ? error.message : "error";
      out.push({ type: "error", error: { code: code.replace(/[^\w.-]/g, "").slice(0, 40) || "error" } });
      return;
    }
    case "session.closed":
      out.push({ type: "session.closed", ...(typeof v3.reason === "string" ? { reason: v3.reason } : {}) });
      return;
    default:
      return;
  }
}

const MAX_SPOKEN_WORDS = 2_000;

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Whether the voice said a result: it streams its words one event at a
 * time and says them in its own way ("it will" becomes "it'll", a lead-in
 * is dropped), so the test is that most of the result's longer words came
 * back, not that its text did. */
export function heardBack(text: string, spokenSince: readonly string[]): boolean {
  const all = words(text);
  const telling = all.filter((word) => word.length >= 4);
  const wanted = telling.length ? telling : all;
  if (!wanted.length) return true;
  const said = new Set(spokenSince);
  const found = wanted.filter((word) => said.has(word)).length;
  return found >= Math.ceil(wanted.length * 0.4);
}

/** Translates one controller command into the frame the browser writes into
 * the data channel. Spoken results ride the proven delegation.context.append;
 * everything else — status notes, prompts, directions — goes in as session
 * context. A scoped append reads as the delegation's result: the model speaks
 * it and considers the delegation answered, and the real result that arrives
 * afterwards is dropped (seen live, 2026-10-08), so nothing but commentary
 * may ever be scoped. The controller's event_id is dropped: the probe
 * protocol sends none. */
export function fromControllerCommand(command: Record<string, unknown>): Record<string, unknown> | null {
  if (command.type === "session.close") return { type: "session.close" };
  if (command.type === "session.commentary.append" || command.type === "session.thinking.append" || command.type === "session.instructions.append") {
    const text = typeof command.content === "string" ? command.content.trim() : "";
    if (!text) return null;
    const content = [{ type: "input_text", text }];
    const delegationId = command.type === "session.commentary.append"
      && typeof command.delegation_id === "string" && command.delegation_id ? command.delegation_id : null;
    return delegationId
      ? { type: "delegation.context.append", delegation_item_id: delegationId, channel: "speakable", content }
      : { type: "session.context.append", channel: "speakable", content };
  }
  return null;
}

// ── the relay facade ────────────────────────────────────────────────────

export function codexAttachPseudoUrl(callId: string): string {
  return `codex-live://${encodeURIComponent(callId)}`;
}

export function parseCodexAttachPseudoUrl(url: string): string | null {
  const PREFIX = "codex-live://";
  if (!url.startsWith(PREFIX)) return null;
  const id = decodeURIComponent(url.slice(PREFIX.length));
  return /^[\w-]{1,200}$/.test(id) ? id : null;
}

/** The facade's readyState moves as the relay attaches and closes; LiveSocket
 * reads it. Every LiveSocket consumer accepts this. */
export type CodexRelayFacade = Omit<LiveSocket, "readyState"> & { readyState: number };

export interface CodexRelay {
  /** What the LiveCallController attaches to, in place of an OpenAI socket. */
  readonly facade: CodexRelayFacade;
  /** Pins the person who started the call; the browser's relay requests must
   * carry the same sign-in. The first binding wins. */
  bind(fingerprint: string): boolean;
  /** Serves the down direction (server → browser → data channel) as SSE.
   * False: refused (unbound, wrong person, or the relay is done). */
  openStream(res: import("node:http").ServerResponse, fingerprint: string): boolean;
  /** Up direction: raw data-channel frames from the browser. Returns how
   * many became controller events. */
  up(fingerprint: string, raws: readonly unknown[]): number;
  close(): void;
}

/** A LiveSocket facade over the browser's data channel. The controller
 * assigns onopen/onmessage/onerror/onclose and calls send/close exactly as
 * with a GPT-Live sideband; the browser pipe carries the bytes.
 *
 * The provider ignores a delegation result that arrives while the voice's
 * own turn is still open (seen live, 2026-10-08: the ack is spoken, the
 * result that follows four seconds later never is). The facade therefore
 * tracks the assistant's turn from the relayed events and holds every frame
 * until the turn settles — the same discipline the Realtime-API engine
 * applied around its responses. */
export function createCodexRelay(options: { callId: string; onClosed?(): void }): CodexRelay {
  let fingerprint: string | null = null;
  let attached = false;
  let closed = false;
  let stream: import("node:http").ServerResponse | null = null;
  /** Frames waiting for the browser's relay stream to attach. */
  const queue: QueuedFrame[] = [];
  /** Frames waiting for the voice's open turn to settle. */
  const held: QueuedFrame[] = [];
  let assistantTurnOpen = false;
  /** A turn that never hears its turn.done (the person interrupted it) must
   * not hold results forever: this force-opens the result slot. */
  let turnDeadline: ReturnType<typeof setTimeout> | null = null;
  /** Delegation results awaiting confirmation that the voice spoke them.
   * The provider silently drops a result when a context rollover swallows
   * its turn (seen live, 2026-10-08), so delivery retries until the
   * result's own words come back as output transcript. Each result maps to
   * how many spoken words preceded its first write: only what the voice said
   * afterwards can confirm it. */
  const unconfirmed = new Map<string, number>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const spoken: string[] = [];

  const write = (encoded: string) => {
    if (!attached || !stream) return false;
    try {
      stream.write(encoded);
      return true;
    } catch {
      close();
      return false;
    }
  };

  const flushHeld = () => {
    if (turnDeadline) {
      clearTimeout(turnDeadline);
      turnDeadline = null;
    }
    assistantTurnOpen = false;
    for (const entry of held.splice(0)) {
      if (closed) return;
      if (!write(entry.encoded)) continue;
      if (entry.frame.type === "delegation.context.append") scheduleRetry(entry, 4);
    }
  };

  /** Opens the voice's turn: results wait, but never past HOLD_DEADLINE_MS. */
  const openAssistantTurn = () => {
    assistantTurnOpen = true;
    if (turnDeadline) clearTimeout(turnDeadline);
    turnDeadline = setTimeout(() => {
      turnDeadline = null;
      flushHeld();
    }, HOLD_DEADLINE_MS);
    turnDeadline.unref?.();
  };

  /** Schedules another attempt for a delegation result that has not been
   * heard back. Bounded: four attempts or the first sign the voice spoke. */
  const scheduleRetry = (entry: QueuedFrame, attempt: number) => {
    if (closed || attempt <= 0) return;
    if (!unconfirmed.has(entry.text)) unconfirmed.set(entry.text, spoken.length);
    const delay = attempt === 4 ? 4_500 : attempt === 3 ? 9_000 : 20_000;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (closed || !unconfirmed.has(entry.text)) return;
      if (write(entry.encoded)) scheduleRetry(entry, attempt - 1);
    }, delay);
    timer.unref?.();
    timers.add(timer);
  };

  const frameText = (frame: Record<string, unknown>): string =>
    (frame.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "";

  const encode = (frame: Record<string, unknown>): string =>
    `event: codex\ndata: ${JSON.stringify(frame)}\n\n`;

  /** Writes a translated frame — or holds/queues it when the voice is
   * talking or the browser has not attached yet. Delegation results arm a
   * bounded retry the moment they are actually written. */
  const emit = (frame: Record<string, unknown>): void => {
    const isResult = frame.type === "delegation.context.append";
    const entry: QueuedFrame = { encoded: encode(frame), frame, text: frameText(frame) };
    if (assistantTurnOpen) {
      if (held.length < MAX_HELD_FRAMES) held.push(entry);
      return;
    }
    if (attached && write(entry.encoded)) {
      if (isResult) scheduleRetry(entry, 4);
      return;
    }
    if (queue.length < MAX_QUEUED_FRAMES) queue.push(entry);
  };

  const facade: CodexRelayFacade = {
    readyState: 0,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send(data: string) {
      if (closed) return;
      let command: Record<string, unknown>;
      try {
        command = JSON.parse(data) as Record<string, unknown>;
      } catch {
        return;
      }
      const frame = fromControllerCommand(command);
      if (!frame) return;
      emit(frame);
    },
    close() {
      // The controller hangs up: the browser is told through the relay (its
      // stream ends), and it writes session.close into the data channel on
      // its way down. The provider's session.closed — or the renderer's own
      // hang-up — finishes the call through onclose.
      close();
    },
  };

  function close(): void {
    if (closed) return;
    closed = true;
    facade.readyState = 3;
    if (stream) {
      const res = stream;
      stream = null;
      try { res.end(); } catch { /* the browser is gone anyway */ }
    }
    queue.length = 0;
    held.length = 0;
    if (turnDeadline) clearTimeout(turnDeadline);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    options.onClosed?.();
    // Sync, like a real socket's close event. Re-entrancy is bounded: the
    // controller's finish() nulls the socket before closing it, and `closed`
    // stops the second close() before it starts.
    facade.onclose?.({});
  }

  return {
    facade,
    bind(candidate: string) {
      if (fingerprint !== null) return fingerprint === candidate;
      fingerprint = candidate;
      return true;
    },
    openStream(res, candidate) {
      if (closed || attached || fingerprint === null || candidate !== fingerprint) return false;
      try {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        for (const entry of queue.splice(0)) {
          res.write(entry.encoded);
          if (entry.frame.type === "delegation.context.append") scheduleRetry(entry, 4);
        }
        // writeHead alone does not flush: with nothing queued the client's
        // fetch would hang on invisible headers. A comment frame carries no
        // data and flushes the head at once.
        res.write(": relay\n\n");
      } catch {
        return false;
      }
      attached = true;
      stream = res;
      facade.readyState = 1;
      // A quiet call must not look dead: comment frames keep proxies and
      // clients from closing an idle stream.
      const heartbeat = setInterval(() => {
        if (stream === res) {
          try { res.write(": relay\n\n"); } catch { close(); }
        }
      }, RELAY_HEARTBEAT_MS);
      heartbeat.unref?.();
      res.on("close", () => {
        clearInterval(heartbeat);
        close();
      });
      facade.onopen?.(undefined);
      return true;
    },
    up(candidate, raws) {
      if (closed || fingerprint === null || candidate !== fingerprint) return 0;
      let accepted = 0;
      for (const raw of raws) {
        if (typeof raw !== "string" || !raw || raw.length > MAX_EVENT_CHARS) continue;
        let event: unknown;
        try {
          event = JSON.parse(raw);
        } catch {
          continue;
        }
        // The voice's own speech opens and closes turns; a delegation result
        // is only accepted after the turn that acknowledges it has settled.
        if (event && typeof event === "object" && !Array.isArray(event)) {
          const v3 = event as Record<string, unknown>;
          if (v3.type === "turn.created") openAssistantTurn();
          else if (v3.type === "turn.done") {
            accepted += 1;
            flushHeld();
          } else if (v3.type === "output_transcript.added") {
            const item = v3.item as { text?: unknown } | undefined;
            if (typeof item?.text === "string") {
              spoken.push(...words(item.text));
              if (spoken.length > MAX_SPOKEN_WORDS) {
                const drop = spoken.length - MAX_SPOKEN_WORDS;
                spoken.splice(0, drop);
                for (const [text, mark] of unconfirmed) unconfirmed.set(text, Math.max(0, mark - drop));
              }
              for (const [text, mark] of unconfirmed) {
                if (heardBack(text, spoken.slice(mark))) unconfirmed.delete(text);
              }
            }
          }
        }
        const translated: Array<Record<string, unknown>> = [];
        toControllerEvents(event, translated);
        for (const controllerEvent of translated) {
          accepted += 1;
          try {
            facade.onmessage?.({ data: JSON.stringify(controllerEvent) });
          } catch {
            // guarded() inside the controller turns a bug into a counter
          }
        }
      }
      return accepted;
    },
    close,
  };
}

/** One relay per V3 call, for the routes and the controller wiring to meet
 * in. Entries leave when their relay closes (the browser hung up, the stream
 * dropped, or the call ended); the cap exists to bound a leak, not to gate
 * usage — the controller runs one call at a time anyway. */
export function createCodexRelayRegistry(options: { limit?: number } = {}): {
  create(callId: string): CodexRelay;
  get(callId: string): CodexRelay | undefined;
  /** Re-keys a relay: the session is created under the provider's call id,
   * but the browser only ever names the harness's own call id. */
  rename(fromId: string, toId: string): void;
  dispose(callId: string): void;
  size(): number;
} {
  const limit = options.limit ?? 200;
  const relays = new Map<string, CodexRelay>();
  return {
    create(callId) {
      const existing = relays.get(callId);
      if (existing) return existing;
      const relay = createCodexRelay({ callId, onClosed: () => relays.delete(callId) });
      relays.set(callId, relay);
      while (relays.size > limit) {
        const oldest = relays.keys().next().value;
        if (oldest === undefined) break;
        relays.get(oldest)?.close();
      }
      return relay;
    },
    get: (callId) => relays.get(callId),
    rename(fromId, toId) {
      const relay = relays.get(fromId);
      if (!relay || fromId === toId) return;
      relays.delete(fromId);
      relays.set(toId, relay);
    },
    dispose: (callId) => relays.get(callId)?.close(),
    size: () => relays.size,
  };
}

export type CodexRelayRegistry = ReturnType<typeof createCodexRelayRegistry>;
