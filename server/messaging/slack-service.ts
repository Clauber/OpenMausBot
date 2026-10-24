// Slack inbound/outbound for a bound OpenMausBot bot: one Socket Mode
// WebSocket per binding carries events in (no public URL needed), each
// envelope is acknowledged at once, unknown DMs pair by code, and every
// message reaches the host's guarded-send path (so approval semantics are
// unchanged). Replies leave via chat.postMessage once the turn settles. The
// host (server/index.ts) supplies everything that touches bots and threads;
// this module never imports it.
import { createHash } from "node:crypto";
import { z } from "zod";

import type { SlackBinding, SlackBindingStore } from "./slack-store.ts";
import { createSlackClient, SlackApiError, SlackSocketClosed, type SlackClient } from "./slack.ts";

export type SlackPhase = "working" | "waiting" | "settled" | "untracked";

export interface SlackHost {
  /** The bot's display name, or undefined once it no longer exists. */
  botName(botId: string): string | undefined;
  createThread(botId: string, title: string): string | undefined;
  threadExists(botId: string, threadId: string): boolean;
  /** Start the turn through the guarded-send path. */
  startTurn(input: { botId: string; threadId: string; text: string; sendId: string; senderName: string; senderId: string }):
    Promise<{ ok: true } | { ok: false; error: string }>;
  /** Where the request stands, and the bot's closing text once it has one. */
  readRequest(botId: string, threadId: string, sendId: string): { phase: SlackPhase; reply?: string };
}

export interface SlackServiceOptions {
  store: SlackBindingStore;
  host: SlackHost;
  clientFor?: (binding: SlackBinding) => SlackClient;
  pollMs?: number;
  maxWaitMs?: number;
  /** First wait after a failed connect; doubles up to a minute. */
  reconnectMs?: number;
  /** How long to wait for the hello envelope before hanging up. */
  helloTimeoutMs?: number;
  log?: (message: string) => void;
}

const eventSchema = z.object({
  type: z.literal("message"),
  channel_type: z.literal("im"),
  channel: z.string(),
  user: z.string().optional(),
  bot_id: z.string().optional(),
  subtype: z.string().optional(),
  text: z.string().optional(),
  ts: z.string(),
});
type Event = z.infer<typeof eventSchema>;
const envelopePayloadSchema = z.object({
  type: z.string(),
  event: eventSchema.optional(),
});

const pairingCodePattern = /^\d{6}$/;
function pairingCodeFrom(text: string): string | undefined {
  const bare = text.match(/^(\d{6})$/);
  return bare && pairingCodePattern.test(bare[1]!) ? bare[1] : undefined;
}

/** Config refusals that will not heal by retrying: the tokens or the app's
 * Socket Mode toggle are wrong, and an operator must change something. */
const TERMINAL_CODES = new Set(["invalid_auth", "not_authed", "not_allowed_token_type", "token_revoked", "account_inactive"]);

export class SlackService {
  private readonly o: Required<Omit<SlackServiceOptions, "clientFor" | "log">> & Pick<SlackServiceOptions, "clientFor" | "log">;
  private readonly inflightChats = new Set<string>();
  private readonly pending = new Set<Promise<void>>();
  private readonly sockets = new Map<string, { socket: WebSocket | null; abort: AbortController }>();
  private readonly socketStates = new Map<string, { status: "starting" | "connected" | "reconnecting" | "error" | "stopped"; error?: string; at: number }>();
  private stopped = false;

  constructor(options: SlackServiceOptions) {
    this.o = { pollMs: 1000, maxWaitMs: 30 * 60_000, reconnectMs: 1000, helloTimeoutMs: 10_000, ...options };
  }

  private client(binding: SlackBinding): SlackClient {
    return this.o.clientFor?.(binding) ?? createSlackClient({});
  }

  /** Resolves when every accepted message has been answered (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled(Array.from(this.pending));
  }

  stop(): void {
    this.stopped = true;
    for (const entry of this.sockets.values()) this.close(entry);
  }

  /** Live state of a binding's socket, for the admin API. */
  socketState(bindingId: string): { status: string; error?: string; at: number } | undefined {
    return this.socketStates.get(bindingId);
  }

  /** Start (or no-op) the Socket Mode connection for one binding. */
  startSocket(bindingId: string): void {
    if (this.stopped || this.sockets.has(bindingId)) return;
    const abort = new AbortController();
    this.sockets.set(bindingId, { socket: null, abort });
    this.socketStates.set(bindingId, { status: "starting", at: Date.now() });
    const loop = this.runSocket(bindingId, abort)
      .catch((error) => {
        this.o.log?.(`slack ${bindingId}: socket crashed: ${error instanceof Error ? error.message : String(error)}`);
        this.socketStates.set(bindingId, { status: "error", error: error instanceof Error ? error.message : String(error), at: Date.now() });
      })
      .finally(() => this.sockets.delete(bindingId));
    void loop;
  }

  stopSocket(bindingId: string): void {
    this.close(this.sockets.get(bindingId));
    this.socketStates.set(bindingId, { status: "stopped", at: Date.now() });
  }

  private close(entry: { socket: WebSocket | null; abort: AbortController } | undefined): void {
    if (!entry) return;
    entry.abort.abort();
    try { entry.socket?.close(); } catch { /* already closing */ }
  }

  /** Boot: connect every binding. */
  startAll(): void {
    for (const binding of this.o.store.list()) this.startSocket(binding.id);
  }

  private async runSocket(bindingId: string, abort: AbortController): Promise<void> {
    const { store, reconnectMs, helloTimeoutMs } = this.o;
    let backoff = 0;
    while (!this.stopped && !abort.signal.aborted) {
      const binding = store.get(bindingId);
      if (!binding) break; // deleted: done
      const client = this.client(binding);
      try {
        // The wss URL is temporary by design; a fresh one per (re)connect.
        const url = await client.connectionsOpen(binding.appToken);
        const socket = await this.openSocket(url, abort.signal, helloTimeoutMs, bindingId);
        const entry = this.sockets.get(bindingId);
        if (entry) entry.socket = socket;
        if (abort.signal.aborted) continue;
        // openSocket only resolves once Slack has said hello.
        this.socketStates.set(bindingId, { status: "connected", at: Date.now() });
        backoff = 0;
        const closed = await this.session(socket, bindingId, abort.signal);
        this.socketStates.set(bindingId, { status: "reconnecting", at: Date.now() });
        if (closed.linkDisabled) {
          // Socket Mode was switched off for the app; retrying cannot help.
          this.socketStates.set(bindingId, { status: "error", error: "Slack reports Socket Mode disabled for this app (link_disabled)", at: Date.now() });
          break;
        }
      } catch (error) {
        if (abort.signal.aborted || error instanceof SlackSocketClosed) break;
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof SlackApiError && TERMINAL_CODES.has(error.code)) {
          this.socketStates.set(bindingId, { status: "error", error: message, at: Date.now() });
          break;
        }
        this.socketStates.set(bindingId, { status: "reconnecting", error: message, at: Date.now() });
        backoff = backoff ? Math.min(backoff * 2, 60_000) : reconnectMs;
        await this.wait(backoff, abort.signal);
      }
    }
    const state = this.socketStates.get(bindingId);
    if (state?.status !== "error") this.socketStates.set(bindingId, { status: "stopped", at: Date.now() });
  }

  private openSocket(url: string, signal: AbortSignal, helloTimeoutMs: number, bindingId: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        try { socket.close(); } catch { /* never opened */ }
        reject(new Error(`slack ${bindingId}: no hello within ${Math.round(helloTimeoutMs / 1000)}s`));
      }, helloTimeoutMs);
      socket.addEventListener("open", () => { /* hello decides readiness */ }, { once: true });
      socket.addEventListener("message", function hello(event) {
        try {
          const parsed = JSON.parse(String(event.data)) as { type?: string };
          if (parsed.type !== "hello") return;
        } catch { return; }
        socket.removeEventListener("message", hello);
        clearTimeout(timer);
        resolve(socket);
      });
      socket.addEventListener("close", () => { clearTimeout(timer); reject(new Error("socket closed before hello")); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("socket failed before hello")); }, { once: true });
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        try { socket.close(); } catch { /* never opened */ }
        reject(new SlackSocketClosed());
      }, { once: true });
    });
  }

  /** The live connection: ack every envelope at once (Slack retries what it
   * does not see acked), then hand events_api payloads to dispatch. Resolves
   * with how the socket ended. (Hello was already consumed by openSocket.) */
  private session(socket: WebSocket, bindingId: string, signal: AbortSignal): Promise<{ linkDisabled: boolean }> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (result: { linkDisabled: boolean }) => {
        if (done) return;
        done = true;
        resolve(result);
      };
      socket.addEventListener("message", (event) => {
        let envelope: { type?: string; envelope_id?: string; payload?: unknown };
        try { envelope = JSON.parse(String(event.data)); } catch { return; }
        if (envelope.type === "hello") return;
        if (envelope.type === "disconnect") {
          const reason = (envelope as { reason?: string }).reason;
          try { socket.close(); } catch { /* already closing */ }
          finish({ linkDisabled: reason === "link_disabled" });
          return;
        }
        if (!envelope.envelope_id) return;
        try { socket.send(JSON.stringify({ envelope_id: envelope.envelope_id })); } catch { /* closing; Slack redelivers */ }
        if (envelope.type !== "events_api") return;
        const payload = envelopePayloadSchema.safeParse(envelope.payload);
        if (!payload.success || !payload.data.event) return;
        // Slack redelivers un-acked envelopes; a deterministic sendId per ts
        // means a replay starts the turn once, not twice.
        this.dispatch(bindingId, payload.data.event);
      });
      socket.addEventListener("close", () => finish({ linkDisabled: false }), { once: true });
      socket.addEventListener("error", () => { /* close follows */ });
      signal.addEventListener("abort", () => {
        try { socket.close(); } catch { /* already closing */ }
        finish({ linkDisabled: false });
      }, { once: true });
    });
  }

  /** Shared inbound path: DM text turns (and pairing codes) run; everything
   * else (own echoes, edits, other event types) is ignored. Fire-and-forget:
   * the socket loop must not wait half an hour for a turn. The binding is
   * re-read so a chat paired between envelopes is seen with its fresh state. */
  private dispatch(bindingId: string, event: Event): Promise<void> | null {
    if (event.bot_id || (event.user && event.user === this.botUserId(bindingId))) return null;
    const work = this.process(bindingId, event)
      .catch((error) => this.o.log?.(`slack ${bindingId}: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => this.pending.delete(work));
    this.pending.add(work);
    return work;
  }

  private botUserId(bindingId: string): string | undefined {
    return this.o.store.get(bindingId)?.botUserId;
  }

  private async process(bindingId: string, event: Event): Promise<void> {
    const { store, host } = this.o;
    const binding = store.get(bindingId);
    if (!binding) return;
    if (event.subtype) return;
    const channelId = event.channel;
    const text = event.text?.trim() ?? "";
    const person = event.user ? `@${event.user}` : channelId;
    const say = (reply: string) => this.client(binding).postMessage(binding.botToken, channelId, reply).catch(() => undefined);
    const botName = host.botName(binding.botId);
    if (!botName) return;

    const chat = binding.chats[channelId];
    if (!chat) {
      const code = pairingCodeFrom(text);
      if (!code && !store.pairingActive(binding.id)) {
        await say("This conversation isn't paired with a bot yet. Ask its owner for a pairing code and send it here.");
        return;
      }
      if (!code || !store.tryPairingCode(binding.id, code)) {
        await say("That code didn't match, or it has expired. Ask the owner for a new one.");
        return;
      }
      const threadId = host.createThread(binding.botId, `Slack · ${person}`);
      if (!threadId) return;
      store.bindChat(binding.id, channelId, { threadId, name: person, ...(event.user ? { userId: `slack:${event.user}` } : {}) });
      await say(`Paired with ${botName}. Send a message to start.`);
      return;
    }
    if (!chat.enabled) return;
    if (!text) { await say("Only text messages are supported for now."); return; }

    const key = `${binding.id}:${channelId}`;
    if (this.inflightChats.has(key)) { await say("Still working on your previous message. I'll answer it first."); return; }
    this.inflightChats.add(key);
    try {
      let threadId = chat.threadId;
      if (!host.threadExists(binding.botId, threadId)) {
        const fresh = host.createThread(binding.botId, `Slack · ${person}`);
        if (!fresh) return;
        threadId = fresh;
        store.bindChat(binding.id, channelId, { threadId, name: person, ...(event.user ? { userId: `slack:${event.user}` } : {}) });
      }
      await this.relay(binding, channelId, threadId, text, event.ts, event.user);
    } finally {
      this.inflightChats.delete(key);
    }
  }

  private async relay(binding: SlackBinding, channelId: string, threadId: string, text: string, ts: string, user?: string): Promise<void> {
    const { host, pollMs, maxWaitMs } = this.o;
    const client = this.client(binding);
    // Deterministic, so Slack redelivering an envelope (or a restart) cannot start the turn twice.
    const sendId = `sl-${createHash("sha256").update(binding.id).digest("hex").slice(0, 12)}-${ts.replace(".", "-")}`;
    const started = await host.startTurn({
      botId: binding.botId, threadId, text, sendId,
      senderName: user ? `@${user}` : "Slack",
      senderId: `slack:${user ?? channelId}`,
    });
    if (!started.ok) { await client.postMessage(binding.botToken, channelId, started.error).catch(() => undefined); return; }

    const deadline = Date.now() + maxWaitMs;
    let notifiedWaiting = false;
    let untrackedPolls = 0;
    while (!this.stopped && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      let state: ReturnType<SlackHost["readRequest"]>;
      try { state = host.readRequest(binding.botId, threadId, sendId); }
      catch { state = { phase: "untracked" }; }
      untrackedPolls = state.phase === "untracked" ? untrackedPolls + 1 : 0;
      if (state.phase === "settled" || (state.phase === "untracked" && untrackedPolls >= 3)) {
        if (state.reply?.trim()) await client.postMessage(binding.botToken, channelId, state.reply).catch(() => undefined);
        else await client.postMessage(binding.botToken, channelId, state.phase === "settled" ? "(The bot finished without a text reply.)" : "That turn didn't finish. Open the app to see what happened.").catch(() => undefined);
        return;
      }
      if (state.phase === "waiting" && !notifiedWaiting) {
        notifiedWaiting = true;
        await client.postMessage(binding.botToken, channelId, "The bot needs your approval in OpenMausBot to continue.").catch(() => undefined);
      }
    }
    if (!this.stopped) await client.postMessage(binding.botToken, channelId, "The bot is still working. Check the app for the result.").catch(() => undefined);
  }

  private wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
}
