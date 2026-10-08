// The codex (ChatGPT subscription) live-call engine, unit-tested against the
// event sequence the live probes captured (legion-voice-research evidence,
// 2026-10-07): the V3 quicksilver events a browser WebRTC call emits, and the
// delegation.context.append that carries a backend result back to the voice.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_KEY_SENTINEL, codexAttachPseudoUrl, createCodexCredentials, createCodexLiveSession,
  createCodexRelay, createCodexRelayRegistry, fromControllerCommand, parseCodexAttachPseudoUrl,
  parseCodexAuth, toControllerEvents,
} from "./live-codex.ts";
import { LiveSessionError } from "./live-call.ts";
import type { LiveSocket } from "./live-call-controller.ts";

// Real events from evidence/direct-delegation-proof.json (one successful call).
const FIXTURE_SESSION_STARTED = {
  session: { expires_at: 1791399596, id: "rtc_u4_EWPHgp3oMTwRNTiewdBTXyHeHjTZA00g", status: "active" },
  type: "session.started",
};
const FIXTURE_INPUT_WORD = {
  end_ms: 19000, item: { id: "item_EWPIDOWjYVXqGae3rI18B", text: " Please", type: "input_transcript" },
  start_ms: 18800, type: "input_transcript.added",
};
const FIXTURE_TURN_DELTA = { delta: " ask", end_ms: 19200, start_ms: 19000, turn_id: "turn_EWPIDxCaaVPDkjcuJbzaX", type: "turn.delta" };
const FIXTURE_DELEGATION = {
  item: {
    content: [{ text: "Please ask my agent to calculate six times seven", type: "input_text" }],
    handoff_id: "handoff_1", id: "item_EWPIGQiEqLq2GhZcDpnHi", target: "client", type: "delegation",
    user_bidi_turn_id: "turn_EWPIDxCaaVPDkjcuJbzaX",
  },
  offset_ms: 21400, type: "delegation.created",
};
const FIXTURE_OUTPUT_WORD = {
  end_ms: 21800, item: { id: "item_EWPIGEArrWrma3XUJc454", text: " One moment", type: "output_transcript" },
  start_ms: 21600, type: "output_transcript.added",
};
const FIXTURE_USAGE = {
  type: "session.usage.updated",
  usage: { audio_duration_ms: 800, backend_model_usage: [] },
  usage_limit: { reset_seconds: null, status: null },
};
const FIXTURE_APPEND_ACK = {
  delegation_item_id: "item_EWPIGQiEqLq2GhZcDpnHi", end_ms: 55200, start_ms: 55000, type: "delegation.context.appended",
};

describe("codex protocol translation (provider → controller)", () => {
  it("passes session.started through", () => {
    const out: Array<Record<string, unknown>> = [];
    toControllerEvents(FIXTURE_SESSION_STARTED, out);
    expect(out).toEqual([{ type: "session.started", session: { id: FIXTURE_SESSION_STARTED.session.id } }]);
  });

  it("turns each input_transcript.added word into an input transcript delta", () => {
    const out: Array<Record<string, unknown>> = [];
    toControllerEvents(FIXTURE_INPUT_WORD, out);
    expect(out).toEqual([{ type: "session.input_transcript.delta", delta: " Please", start_ms: 18800, end_ms: 19000 }]);
  });

  it("turns each output_transcript.added word into an output transcript delta", () => {
    const out: Array<Record<string, unknown>> = [];
    toControllerEvents(FIXTURE_OUTPUT_WORD, out);
    expect(out).toEqual([{ type: "session.output_transcript.delta", delta: " One moment", start_ms: 21600, end_ms: 21800 }]);
  });

  it("turns a client delegation into session.delegation.created", () => {
    const out: Array<Record<string, unknown>> = [];
    toControllerEvents(FIXTURE_DELEGATION, out);
    expect(out).toEqual([{
      type: "session.delegation.created",
      delegation: { id: "item_EWPIGQiEqLq2GhZcDpnHi", target: "client" },
      offset_ms: 21400,
    }]);
  });

  it("ignores delegations that do not target the client", () => {
    const out: Array<Record<string, unknown>> = [];
    toControllerEvents({ ...FIXTURE_DELEGATION, item: { ...FIXTURE_DELEGATION.item, target: "server" } }, out);
    expect(out).toEqual([]);
  });

  it("maps usage duration to seconds for the call summary", () => {
    const out: Array<Record<string, unknown>> = [];
    toControllerEvents(FIXTURE_USAGE, out);
    expect(out).toEqual([{ type: "session.usage.updated", usage: { seconds: 0.8 } }]);
  });

  it("ignores turn bookkeeping, append acknowledgements and unknown events", () => {
    for (const event of [
      FIXTURE_TURN_DELTA,
      FIXTURE_APPEND_ACK,
      { turn: { id: "turn_1", role: "assistant", transcript: "hi" }, type: "turn.created" },
      { turn: { id: "turn_1" }, type: "turn.done" },
      { type: "session.updated" },
      "not an object",
      { type: "mystery.event" },
    ]) {
      const out: Array<Record<string, unknown>> = [];
      toControllerEvents(event as Record<string, unknown>, out);
      expect(out).toEqual([]);
    }
  });

  it("passes provider errors through with their code", () => {
    const out: Array<Record<string, unknown>> = [];
    toControllerEvents({ type: "error", error: { code: "rate_limit_exceeded", message: "slow down" } }, out);
    expect(out).toEqual([{ type: "error", error: { code: "rate_limit_exceeded" } }]);
  });

  it("passes session.closed through for the controller's close reasons", () => {
    const out: Array<Record<string, unknown>> = [];
    toControllerEvents({ type: "session.closed", reason: "connection_lost" }, out);
    expect(out).toEqual([{ type: "session.closed", reason: "connection_lost" }]);
  });
});

describe("codex protocol translation (controller → provider)", () => {
  it("carries a spoken result as a delegation.context.append on the delegation", () => {
    expect(fromControllerCommand({
      type: "session.commentary.append", delegation_id: "item_EWPIGQiEqLq2GhZcDpnHi", content: "Six times seven is forty-two.", event_id: "omb_1",
    })).toEqual({
      type: "delegation.context.append",
      delegation_item_id: "item_EWPIGQiEqLq2GhZcDpnHi",
      channel: "speakable",
      content: [{ type: "input_text", text: "Six times seven is forty-two." }],
    });
  });

  it("sends status notes and prompts as session context, never as a delegation result", () => {
    // A scoped append reads as the delegation's result; the model then speaks
    // it and the real result is dropped (seen live, 2026-10-08). Only
    // commentary — the actual answer — may be scoped.
    for (const type of ["session.thinking.append", "session.instructions.append"]) {
      expect(fromControllerCommand({ type, delegation_id: "d1", content: "Checking." })).toEqual({
        type: "session.context.append",
        channel: "speakable",
        content: [{ type: "input_text", text: "Checking." }],
      });
    }
  });

  it("sends appends with no delegation as session context, not a fabricated result", () => {
    expect(fromControllerCommand({ type: "session.thinking.append", delegation_id: null, content: "Still working." })).toEqual({
      type: "session.context.append",
      channel: "speakable",
      content: [{ type: "input_text", text: "Still working." }],
    });
  });

  it("strips the controller's event_id: the probe protocol sends none", () => {
    const out = fromControllerCommand({ type: "session.commentary.append", delegation_id: "d1", content: "x", event_id: "omb_9" }) as Record<string, unknown>;
    expect(Object.hasOwn(out, "event_id")).toBe(false);
  });

  it("lets session.close through unchanged", () => {
    expect(fromControllerCommand({ type: "session.close", event_id: "omb_2" })).toEqual({ type: "session.close" });
  });

  it("ignores commands it does not own (audio goes over RTP, not the data channel)", () => {
    expect(fromControllerCommand({ type: "session.input_audio.append", audio: "base64" })).toBeNull();
    expect(fromControllerCommand({ type: "garbage" })).toBeNull();
  });
});

// ── credential: parse, refresh, write-back ──────────────────────────────

const JWT = (exp: number) => `x.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.y`;

function authJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    last_refresh: "2026-10-06T18:05:59.790697Z",
    tokens: {
      access_token: JWT(Math.floor(Date.now() / 1000) + 3600),
      account_id: "acc_123",
      id_token: "id-token-value",
      refresh_token: "rt-original",
      ...overrides,
    },
  });
}

function memoryIo(initial: string) {
  const state = { raw: initial, writes: 0, mtime: 1 };
  return {
    state,
    io: {
      readRaw: () => state.raw,
      writeRaw: (_path: string, raw: string) => { state.raw = raw; state.writes += 1; },
      mtimeMs: () => state.mtime,
    },
  };
}

describe("codex credential", () => {
  it("parses the ChatGPT sign-in shape auth.json holds", () => {
    const auth = parseCodexAuth(authJson())!;
    expect(auth.accountId).toBe("acc_123");
    expect(auth.refreshToken).toBe("rt-original");
    expect(auth.token).toContain(".");
    expect(auth.expiresAt).toBeGreaterThan(Date.now());
  });

  it("rejects auth.json without a ChatGPT sign-in (API-key mode, garbage, empty)", () => {
    expect(parseCodexAuth(JSON.stringify({ OPENAI_API_KEY: "sk-x" }))).toBeNull();
    expect(parseCodexAuth("not json")).toBeNull();
    expect(parseCodexAuth("{}")).toBeNull();
    expect(parseCodexAuth(authJson({ access_token: "" }))).toBeNull();
  });

  it("does not refresh a token with time to spare", async () => {
    const { io } = memoryIo(authJson());
    const fetchImpl = vi.fn();
    const credentials = createCodexCredentials({ io, fetchImpl });
    const auth = await credentials.fresh();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(auth?.accountId).toBe("acc_123");
  });

  it("refreshes an expiring token and writes the new one back to auth.json", async () => {
    const oldToken = JWT(Math.floor(Date.now() / 1000) + 60);
    const newToken = JWT(Math.floor(Date.now() / 1000) + 3600);
    const { io, state } = memoryIo(authJson({ access_token: oldToken }));
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ access_token: newToken, refresh_token: "rt-new" }), { status: 200 }));
    const credentials = createCodexCredentials({ io, fetchImpl });
    const auth = await credentials.fresh();
    expect(auth?.token).toBe(newToken);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://auth.openai.com/oauth/token");
    expect(JSON.parse(String(init.body))).toEqual({ grant_type: "refresh_token", refresh_token: "rt-original", client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
    // the sign-in file stays whole: new tokens in, everything else kept
    expect(state.writes).toBe(1);
    const written = JSON.parse(state.raw) as { tokens: Record<string, string>; last_refresh: string; id_token: string };
    expect(written.tokens.access_token).toBe(newToken);
    expect(written.tokens.refresh_token).toBe("rt-new");
    expect(written.tokens.id_token).toBe("id-token-value");
    expect(written.last_refresh).toBeTruthy();
    expect(written.tokens.account_id).toBe("acc_123");
  });

  it("falls back to the still-valid token when the refresh fails", async () => {
    // past the refresh skew but not yet expired
    const { io, state } = memoryIo(authJson({ access_token: JWT(Math.floor(Date.now() / 1000) + 240) }));
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 500 }));
    const credentials = createCodexCredentials({ io, fetchImpl });
    const auth = await credentials.fresh();
    expect(auth?.accountId).toBe("acc_123");
    expect(state.writes).toBe(0);
  });

  it("reports no usable credential once the token is expired and refresh fails", async () => {
    const { io } = memoryIo(authJson({ access_token: JWT(Math.floor(Date.now() / 1000) - 10) }));
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 400 }));
    const credentials = createCodexCredentials({ io, fetchImpl });
    await expect(credentials.fresh()).resolves.toBeNull();
    expect(credentials.configured()).toBe(true); // a sign-in exists: refresh may work next time
  });

  it("refreshes once for concurrent callers", async () => {
    const { io, state } = memoryIo(authJson({ access_token: JWT(Math.floor(Date.now() / 1000) + 60) }));
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(JSON.stringify({ access_token: JWT(Math.floor(Date.now() / 1000) + 3600) }), { status: 200 });
    });
    const credentials = createCodexCredentials({ io, fetchImpl });
    const [a, b] = await Promise.all([credentials.fresh(), credentials.fresh()]);
    expect(calls).toBe(1);
    expect(a?.token).toBe(b?.token);
    expect(state.writes).toBe(1);
  });

  it("counts a sign-in with a refresh token as configured even when expired", () => {
    const { io } = memoryIo(authJson({ access_token: JWT(Math.floor(Date.now() / 1000) - 10) }));
    expect(createCodexCredentials({ io }).configured()).toBe(true);
    expect(createCodexCredentials({ io: memoryIo("{}").io }).configured()).toBe(false);
  });

  it("skips the write-back when the file changed underneath (the Codex CLI refreshed)", async () => {
    const oldToken = JWT(Math.floor(Date.now() / 1000) + 60);
    const newToken = JWT(Math.floor(Date.now() / 1000) + 3600);
    const touched = { raw: authJson({ access_token: oldToken }), writes: 0 };
    let stats = 0;
    const io = {
      readRaw: () => touched.raw,
      writeRaw: (_path: string, raw: string) => { touched.raw = raw; touched.writes += 1; },
      // the mtime the write-back decision sees: changed after our first read
      mtimeMs: () => (stats += 1) === 1 ? 1 : 2,
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: newToken }), { status: 200 }));
    const credentials = createCodexCredentials({ io, fetchImpl });
    const auth = await credentials.fresh();
    // the call still gets the fresh token, but the file was left for whoever touched it
    expect(auth?.token).toBe(newToken);
    expect(touched.writes).toBe(0);
    expect((JSON.parse(touched.raw) as { tokens: { access_token: string } }).tokens.access_token).toBe(oldToken);
  });
});

// ── session creation ────────────────────────────────────────────────────

const OFFER_SDP = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const ANSWER_SDP = "v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\n";

function credentialsWith(token: string) {
  return {
    fresh: vi.fn(async () => ({ token, accountId: "acc_123", refreshToken: "rt", expiresAt: Date.now() + 3_600_000 })),
    read: vi.fn(() => ({ token, accountId: "acc_123", refreshToken: "rt", expiresAt: Date.now() + 3_600_000 })),
    configured: vi.fn(() => true),
  };
}

function codexEnv(overrides: Record<string, string> = {}) {
  return {
    OMB_CODEX_LIVE_URL: "http://127.0.0.1:9",
    OMB_CODEX_OAUTH_URL: "http://127.0.0.1:9",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe("codex session creation", () => {
  const baseInput = {
    sdp: OFFER_SDP,
    bot: { name: "Ada", title: "researcher" },
    voice: "cove",
    env: codexEnv(),
  };

  it("posts the proven V3 quicksilver shape and returns the answer SDP", async () => {
    const credentials = credentialsWith("tok-1");
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(ANSWER_SDP, { status: 201, headers: { location: "/backend-api/codex/realtime/calls/rtc_call_1" } }));
    const result = await createCodexLiveSession({ ...baseInput, credentials: credentials as never, fetchImpl });
    expect(result).toEqual({ sessionId: "rtc_call_1", sdp: ANSWER_SDP });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:9/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok-1");
    expect(headers["chatgpt-account-id"]).toBe("acc_123");
    expect(headers["openai-alpha"]).toBe("quicksilver=v2");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.originator).toBe("openmausbot");
    const body = JSON.parse(String(init.body)) as { sdp: string; session: Record<string, unknown> };
    expect(body.sdp).toBe(OFFER_SDP);
    expect(body.session).toMatchObject({
      model: "gpt-live-1-codex",
      audio: { output: { voice: "cove" } },
      delegation: { type: "client" },
    });
    expect(String(body.session.instructions)).toContain("Ada");
  });

  it("falls back to a V3 voice when the configured one is a GPT-Live name", async () => {
    const credentials = credentialsWith("tok-1");
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(ANSWER_SDP, { status: 201, headers: { location: "/calls/rtc_1" } }));
    await createCodexLiveSession({ ...baseInput, voice: "marin", credentials: credentials as never, fetchImpl });
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as { session: { audio: { output: { voice: string } } } };
    expect(body.session.audio.output.voice).toBe("cove");
  });

  it("refuses to start without a usable credential, saying so without secrets", async () => {
    const credentials = { fresh: vi.fn(async () => null), read: vi.fn(() => null), configured: vi.fn(() => false) };
    await expect(createCodexLiveSession({
      ...baseInput, credentials: credentials as never, fetchImpl: vi.fn(),
    })).rejects.toMatchObject({ status: 400 });
  });

  it("retries once on a 401 with a freshly refreshed token", async () => {
    const credentials = credentialsWith("tok-stale");
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      const bearer = (init?.headers as Record<string, string> | undefined)?.authorization;
      return bearer === "Bearer tok-fresh"
        ? new Response(ANSWER_SDP, { status: 201, headers: { location: "/calls/rtc_2" } })
        : new Response(JSON.stringify({ error: "expired" }), { status: 401 });
    });
    credentials.fresh.mockImplementation(async ({ force }: { force?: boolean } = {}) =>
      force ? { token: "tok-fresh", accountId: "acc_123", refreshToken: "rt", expiresAt: Date.now() + 3_600_000 } : { token: "tok-stale", accountId: "acc_123", refreshToken: "rt", expiresAt: Date.now() + 3_600_000 });
    const result = await createCodexLiveSession({ ...baseInput, credentials: credentials as never, fetchImpl });
    expect(result.sessionId).toBe("rtc_2");
    expect(calls).toBe(2);
  });

  it("does not retry a 403 (that is an entitlement problem, not a stale token)", async () => {
    const credentials = credentialsWith("tok-1");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "denied" }), { status: 403 }));
    await expect(createCodexLiveSession({ ...baseInput, credentials: credentials as never, fetchImpl })).rejects.toMatchObject({ status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps upstream failures to user-facing errors that carry no token", async () => {
    const secret = "tok-secret-value-123";
    const attempts: Array<{ fetchImpl: () => Promise<Response>; status: number }> = [
      { fetchImpl: async () => new Response("server exploded", { status: 500 }), status: 502 },
      { fetchImpl: async () => new Response("slow", { status: 429 }), status: 429 },
      { fetchImpl: async () => { throw new DOMException("timed out", "TimeoutError"); }, status: 502 },
      { fetchImpl: async () => { throw new TypeError("fetch failed"); }, status: 502 },
    ];
    for (const attempt of attempts) {
      const error = await createCodexLiveSession({
        ...baseInput, credentials: credentialsWith(secret) as never, fetchImpl: vi.fn(attempt.fetchImpl),
      }).then(() => { throw new Error("the call should have failed"); }, (reason: unknown) => reason as LiveSessionError);
      expect(error).toBeInstanceOf(LiveSessionError);
      expect(error.status).toBe(attempt.status);
      expect(error.message).not.toContain(secret);
    }
  });
});

// ── the browser relay facade ────────────────────────────────────────────

class FakeSseResponse {
  headers: Record<string, string> | null = null;
  frames: string[] = [];
  ended = false;
  listeners: Record<string, Array<() => void>> = {};
  writeHead(status: number, headers: Record<string, string>) { this.headers = { status: String(status), ...headers }; }
  write(frame: string) { this.frames.push(frame); return true; }
  end() { this.ended = true; this.emit("close"); }
  on(event: string, fn: () => void) { (this.listeners[event] ??= []).push(fn); }
  emit(event: string) { for (const fn of this.listeners[event] ?? []) fn(); }
}

function relayWithFacade() {
  const relay = createCodexRelay({ callId: "rtc_1" });
  const received: Array<Record<string, unknown>> = [];
  const closed = vi.fn();
  const facade = relay.facade;
  facade.onmessage = (event) => received.push(JSON.parse(String(event.data)) as Record<string, unknown>);
  facade.onclose = closed;
  return { relay, facade, received, closed };
}

function facadeSend(relay: { facade: { send(data: string): void } }, command: Record<string, unknown>): void {
  relay.facade.send(JSON.stringify({ ...command, event_id: "omb_test" }));
}

describe("codex relay facade", () => {
  it("opens when the browser's relay stream attaches, and flushes queued appends", () => {
    const { relay, facade } = relayWithFacade();
    const opened = vi.fn();
    facade.onopen = opened;
    relay.bind("fp-1");
    expect(facade.readyState).toBe(0);
    facade.send(JSON.stringify({ type: "session.commentary.append", delegation_id: "d1", content: "Answer.", event_id: "omb_1" }));
    const res = new FakeSseResponse();
    expect(relay.openStream(res as never, "wrong")).toBe(false);
    expect(res.headers).toBeNull();
    expect(relay.openStream(res as never, "fp-1")).toBe(true);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(facade.readyState).toBe(1);
    expect(res.headers?.status).toBe("200");
    // the comment frame flushes the head; the queued append follows
    expect(res.frames.filter((frame) => frame.startsWith("event:"))).toHaveLength(1);
    const frame = JSON.parse(res.frames.find((f) => f.startsWith("event:"))!.replace(/^event: codex\ndata: /, "").trim()) as Record<string, unknown>;
    expect(frame).toMatchObject({ type: "delegation.context.append", delegation_item_id: "d1" });
  });

  it("delivers controller appends straight through once attached", () => {
    const { relay, facade } = relayWithFacade();
    relay.bind("fp");
    const res = new FakeSseResponse();
    relay.openStream(res as never, "fp");
    facade.send(JSON.stringify({ type: "session.close", event_id: "omb_2" }));
    const frame = JSON.parse(res.frames.at(-1)!.replace(/^event: codex\ndata: /, "").trim()) as Record<string, unknown>;
    expect(frame).toEqual({ type: "session.close" });
    expect(res.ended).toBe(false); // the provider closes; the facade waits like the API-key sideband
  });

  it("translates relayed V3 events into controller events, in order", () => {
    const { relay, received } = relayWithFacade();
    relay.bind("fp");
    relay.up("fp", [
      JSON.stringify(FIXTURE_SESSION_STARTED),
      JSON.stringify(FIXTURE_INPUT_WORD),
      "not json",
      JSON.stringify(FIXTURE_DELEGATION),
    ]);
    expect(received.map((event) => event.type)).toEqual(["session.started", "session.input_transcript.delta", "session.delegation.created"]);
  });

  it("refuses relay traffic that is not bound to this call's person", () => {
    const { relay, received } = relayWithFacade();
    relay.bind("fp");
    expect(relay.up("other", [JSON.stringify(FIXTURE_SESSION_STARTED)])).toBe(0);
    expect(received).toEqual([]);
  });

  it("ends the facade when the browser's relay stream drops", () => {
    const { relay, facade, closed } = relayWithFacade();
    relay.bind("fp");
    const res = new FakeSseResponse();
    relay.openStream(res as never, "fp");
    res.end();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(facade.readyState).toBe(3);
    expect(relay.up("fp", ["{}"])).toBe(0);
  });

  it("keeps working when events arrive before the stream attaches", () => {
    const { relay, received } = relayWithFacade();
    relay.bind("fp");
    expect(relay.up("fp", [JSON.stringify(FIXTURE_SESSION_STARTED)])).toBe(1);
    expect(received).toHaveLength(1);
  });

  it("holds a result until the voice's own turn settles, then flushes it", () => {
    const { relay } = relayWithFacade();
    relay.bind("fp");
    const res = new FakeSseResponse();
    relay.openStream(res as never, "fp");
    // the ack went in as session context and the model starts speaking it
    facadeSend(relay, { type: "session.thinking.append", delegation_id: null, content: "Checking." });
    const down = () => res.frames.filter((f) => f.startsWith("event:")).map((f) => JSON.parse(f.replace(/^event: codex\ndata: /, "").trim()) as Record<string, unknown>);
    // the model's ack turn opens, and the result arrives while it talks
    relay.up("fp", [JSON.stringify({ type: "turn.created", turn: { id: "t1", role: "assistant", transcript: "One moment" } })]);
    facadeSend(relay, { type: "session.commentary.append", delegation_id: "d1", content: "Forty-two." });
    expect(down().some((f) => f.type === "delegation.context.append")).toBe(false);
    // the ack turn settles: the result goes out
    relay.up("fp", [JSON.stringify({ type: "turn.done", turn: { id: "t1", role: "assistant", transcript: "One moment." } })]);
    const frames = down();
    expect(frames.some((f) => f.type === "session.context.append")).toBe(true);
    expect(frames.some((f) => f.type === "delegation.context.append" && f.delegation_item_id === "d1")).toBe(true);
  });

  it("re-sends a result the voice never spoke, and stops once it is spoken", () => {
    vi.useFakeTimers();
    try {
      const { relay } = relayWithFacade();
      relay.bind("fp");
      const res = new FakeSseResponse();
      relay.openStream(res as never, "fp");
      facadeSend(relay, { type: "session.commentary.append", delegation_id: "d9", content: "Six times seven is forty-two." });
      const spoken = () => res.frames.filter((f) => f.startsWith("event:"))
        .map((f) => JSON.parse(f.replace(/^event: codex\ndata: /, "").trim()) as Record<string, unknown>)
        .filter((f) => f.type === "delegation.context.append");
      expect(spoken()).toHaveLength(1);
      // the provider ignores it (a rollover swallowed the turn): try again
      vi.advanceTimersByTime(4_500);
      expect(spoken().length).toBeGreaterThanOrEqual(2);
      vi.advanceTimersByTime(9_000);
      expect(spoken().length).toBeGreaterThanOrEqual(3);
      // the voice speaks the result: no further retries
      relay.up("fp", [JSON.stringify({
        type: "output_transcript.added",
        item: { id: "item_out1", text: " Six times seven is forty-two.", type: "output_transcript" },
        start_ms: 1_000, end_ms: 2_000,
      })]);
      const count = spoken().length;
      vi.advanceTimersByTime(60_000);
      expect(spoken()).toHaveLength(count);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends a result straight through when no assistant turn is open", () => {
    const { relay } = relayWithFacade();
    relay.bind("fp");
    const res = new FakeSseResponse();
    relay.openStream(res as never, "fp");
    facadeSend(relay, { type: "session.commentary.append", delegation_id: "d2", content: "Forty-two." });
    const frames = res.frames.filter((f) => f.startsWith("event:")).map((f) => JSON.parse(f.replace(/^event: codex\ndata: /, "").trim()) as Record<string, unknown>);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "delegation.context.append", delegation_item_id: "d2" });
  });
});

describe("codex relay registry", () => {
  it("hands one facade per call and disposes it when the relay closes", () => {
    const registry = createCodexRelayRegistry();
    const relay = registry.create("rtc_1");
    expect(registry.get("rtc_1")).toBe(relay);
    expect(registry.get("rtc_2")).toBeUndefined();
    const closed = vi.fn();
    relay.facade.onclose = closed;
    registry.dispose("rtc_1");
    expect(closed).toHaveBeenCalled();
    expect(registry.get("rtc_1")).toBeUndefined();
  });

  it("evicts the oldest relay beyond its limit", () => {
    const registry = createCodexRelayRegistry({ limit: 2 });
    registry.create("a");
    registry.create("b");
    registry.create("c");
    expect(registry.get("a")).toBeUndefined();
    expect(registry.get("c")).toBeDefined();
  });
});

// ── pseudo attach URL ───────────────────────────────────────────────────

describe("codex attach pseudo url", () => {
  it("round-trips a call id and rejects everything else", () => {
    const url = codexAttachPseudoUrl("rtc_abc-1");
    expect(url.startsWith("codex-live:")).toBe(true);
    expect(parseCodexAttachPseudoUrl(url)).toBe("rtc_abc-1");
    expect(parseCodexAttachPseudoUrl("ws://127.0.0.1/x")).toBeNull();
    expect(parseCodexAttachPseudoUrl("codex-live://bad id")).toBeNull();
    expect(parseCodexAttachPseudoUrl("../etc/passwd")).toBeNull();
  });
});

// ── sentinel ────────────────────────────────────────────────────────────

describe("codex key sentinel", () => {
  it("is a non-empty string the controller's key check accepts", () => {
    expect(CODEX_KEY_SENTINEL.trim().length).toBeGreaterThan(0);
  });
});

// A facade must satisfy the controller's LiveSocket contract.
describe("facade shape", () => {
  it("has the LiveSocket surface the controller assigns to", () => {
    const { relay } = relayWithFacade();
    const facade: LiveSocket = relay.facade;
    expect(typeof facade.send).toBe("function");
    expect(typeof facade.close).toBe("function");
    expect(facade.onopen).toBeNull();
  });
});

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.useRealTimers(); });
