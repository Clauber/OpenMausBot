// Live calls (GPT-Live as the voice, the bot as the brain). The call itself
// runs in LiveCallController; these routes start it, end it, report it and
// change its non-secret settings. The OpenAI key is never read or written
// here. All are admin-scoped by default in server/request-auth.ts; the
// companion allows the first four for the phone apps (companion/src/routes.ts).
// The fifth, device-revoked, is the companion's own notice that it unpaired a
// phone; a phone can never send it (companion/src/routes.ts COMPANION_NOTICES).
//
// The last two routes carry a codex-engine call's data channel: the browser
// pipes raw V3 frames up and reads the server's appends down. The server
// decides everything; the browser is the untrusted pipe (see live-codex.ts).
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { LiveSettings } from "../../shared/wire.ts";
import { LiveSessionError, MAX_SDP_BYTES } from "../live-call.ts";
import { LiveCallBusyError, type LiveCallController } from "../live-call-controller.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

export interface LiveRouteDeps {
  calls: Pick<LiveCallController, "start" | "end" | "current" | "deviceRevoked">;
  /** The bot and chat a call goes to; no threadId means the bot's current chat. Null when either is unknown. */
  resolveTarget(botId: string, threadId: string | undefined): { botId: string; botName: string; threadId: string } | null;
  settings(): LiveSettings;
  saveSettings(patch: { provider?: "openai" | "codex"; voice?: string; readTypedReplies?: boolean; idleMinutes?: number }): Promise<LiveSettings>;
  /** The codex engine's browser relay; absent when the harness has no codex engine wired. */
  relay?: {
    /** Pins the person who started the call, so only their browser can relay it. */
    bind(callId: string, fingerprint: string): boolean;
    /** Serves the down direction as SSE. False: the call has no relay or the person does not match. */
    openStream(callId: string, fingerprint: string, res: ServerResponse): boolean;
    /** Up direction: raw data-channel frames. Null: no such relay. */
    up(callId: string, fingerprint: string, raws: readonly unknown[]): number | null;
  };
}

const id = z.string().regex(/^[\w-]{1,120}$/);
const sessionBody = z.object({
  botId: id,
  threadId: id.optional(),
  // Not trimmed: the SDP offer goes to OpenAI byte for byte.
  sdp: z.string().min(1).refine((sdp) => Buffer.byteLength(sdp) <= MAX_SDP_BYTES),
  client: z.enum(["desktop", "ios", "android"]),
}).strict();
const endBody = z.object({ callId: z.string().min(1).max(120) }).strict();
// Strict, so `key` (or anything else) is refused rather than ignored: the key
// is only ever set on the computer that runs the harness.
const settingsBody = z.object({
  provider: z.enum(["openai", "codex"]).optional(),
  voice: z.string().trim().max(40).regex(/^[a-z]*$/).optional(),
  readTypedReplies: z.boolean().optional(),
  idleMinutes: z.number().int().min(1).max(60).optional(),
}).strict();
// Data-channel frames pipe through as plain strings; sizes are bounded so a
// runaway renderer cannot flood the harness (a real V3 event is far smaller).
const relayBody = z.object({
  callId: z.string().min(1).max(200),
  events: z.array(z.string().max(32_768)).max(64),
}).strict();

const DEVICE_ID = /^[\w-]{1,128}$/;

/** Who the relay requests must come from: the sign-in that started the call.
 * A call started by a session is relayed only through that session; a call
 * started from this computer (loopback) only through this computer. */
function relayFingerprint(auth: RouteContext["auth"]): string {
  return auth.kind === "session" ? `session:${auth.session.id}` : auth.kind;
}

/** The paired phone the companion vouched for, or undefined. The companion
 * sends its own id for the phone that authenticated (never one the phone
 * chose); in the desktop app the harness has already checked the companion's
 * private token before this runs (server/request-auth.ts). */
function companionDevice(req: IncomingMessage): string | undefined {
  if (req.headers["x-openmausbot-companion"] !== "1") return undefined;
  const device = req.headers["x-openmausbot-companion-device"];
  return typeof device === "string" && DEVICE_ID.test(device) ? device : undefined;
}

/** The parsed JSON body, or undefined when it is not JSON (the schema then refuses it). */
async function bodyOf(req: IncomingMessage, readBody: RouteContext["readBody"]): Promise<unknown> {
  try {
    return await readBody(req);
  } catch {
    return undefined;
  }
}

export function createLiveRoutes(deps: LiveRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody, url }) => {
    if (!path.startsWith("/api/live/")) return PASS;

    if (method === "POST" && path === "/api/live/session") {
      const parsed = sessionBody.safeParse(await bodyOf(req, readBody));
      if (!parsed.success) return json(res, 400, { error: "The call request was not valid." });
      const target = deps.resolveTarget(parsed.data.botId, parsed.data.threadId);
      if (!target) return json(res, 404, { error: "That bot or chat does not exist." });
      try {
        // A phone's call is bound to the phone, so unpairing it ends the call.
        const device = companionDevice(req);
        const { call, sdp } = await deps.calls.start({ auth, ...(device ? { device } : {}), ...target, client: parsed.data.client, sdp: parsed.data.sdp });
        // A codex-engine call's data channel runs through this server: pin
        // the relay to the person who started it before the answer leaves.
        if (call.engine === "codex") deps.relay?.bind(call.callId, relayFingerprint(auth));
        return json(res, 201, { call, transport: { type: "webrtc", sdp } });
      } catch (error) {
        if (error instanceof LiveCallBusyError) return json(res, 409, { error: error.message, activeCall: error.call });
        if (error instanceof LiveSessionError) {
          // The one 409 a session refuses with is a missing key.
          return json(res, error.status, error.status === 409 ? { error: error.message, needsKey: true } : { error: error.message });
        }
        throw error;
      }
    }

    if (method === "POST" && path === "/api/live/call/end") {
      const parsed = endBody.safeParse(await bodyOf(req, readBody));
      if (!parsed.success) return json(res, 400, { error: "The request was not valid." });
      const call = await deps.calls.end(parsed.data.callId);
      return call ? json(res, 200, { call }) : json(res, 404, { error: "That call is not running." });
    }

    if (method === "GET" && path === "/api/live/call") return json(res, 200, { call: deps.calls.current() });

    // The companion unpaired a phone: end the call that phone holds, if any.
    if (method === "POST" && path === "/api/live/device-revoked") {
      if (req.headers["x-openmausbot-companion"] !== "1") return json(res, 403, { error: "Only the phone companion can report an unpaired phone." });
      const device = companionDevice(req);
      if (!device) return json(res, 400, { error: "The unpaired phone was not named." });
      return json(res, 200, { call: deps.calls.deviceRevoked(device) });
    }

    // ── codex-engine relay: the browser's data channel, piped ────────────

    // Up: raw V3 frames the browser read off its data channel. The relay
    // translates them into the controller's dialect; nothing here is trusted.
    if (method === "POST" && path === "/api/live/call/relay") {
      if (!deps.relay) return json(res, 503, { error: "This server does not carry codex voice calls." });
      const parsed = relayBody.safeParse(await bodyOf(req, readBody));
      if (!parsed.success) return json(res, 400, { error: "The relay request was not valid." });
      const fingerprint = relayFingerprint(auth);
      const accepted = deps.relay.up(parsed.data.callId, fingerprint, parsed.data.events);
      return json(res, accepted === null ? 404 : 200, accepted === null ? { error: "That call is not running." } : { accepted });
    }

    // Down: the server's appends for the data channel, as SSE frames. This
    // request is the relay's attach: until it arrives the call stays
    // "connecting", exactly like a sideband dial.
    if (method === "GET" && path === "/api/live/call/relay") {
      const callId = url.searchParams.get("callId") ?? "";
      if (!/^[\w-]{1,200}$/.test(callId)) return json(res, 400, { error: "The relay request was not valid." });
      if (!deps.relay) return json(res, 503, { error: "This server does not carry codex voice calls." });
      if (!deps.relay.openStream(callId, relayFingerprint(auth), res)) {
        // Only reached when no stream was written; a taken or foreign relay
        // says the same thing: there is nothing to attach to.
        if (!res.headersSent) return json(res, 404, { error: "That call is not running." });
      }
      return;
    }

    if (method === "PATCH" && path === "/api/live/settings") {
      const parsed = settingsBody.safeParse(await bodyOf(req, readBody));
      if (!parsed.success) {
        return json(res, 400, { error: "Those Live settings are not valid. The OpenAI key can only be changed on the computer that runs OpenMausBot." });
      }
      // as PUT /api/config: an empty patch is not saved (or broadcast)
      if (!Object.keys(parsed.data).length) return json(res, 400, { error: "nothing to save" });
      return json(res, 200, { live: await deps.saveSettings(parsed.data) });
    }

    return PASS;
  };
}
