// Discord inbound/outbound for a bound Legion bot: one gateway WebSocket
// per binding carries DMs in (identify with the DIRECT_MESSAGES intent — no
// public URL needed), heartbeats keep it alive, unknown DMs pair by code, and
// every message reaches the host's guarded-send path (so approval semantics
// are unchanged). Replies leave via POST /channels/:id/messages once the turn
// settles. The host (server/index.ts) supplies everything that touches bots
// and threads; this module never imports it.
import { createHash } from "node:crypto";
import { z } from "zod";

import type { DiscordBinding, DiscordBindingStore } from "./discord-store.ts";
import { createDiscordClient, DiscordApiError, type DiscordClient } from "./discord.ts";

export type DiscordPhase = "working" | "waiting" | "settled" | "untracked";

export interface DiscordHost {
  /** The bot's display name, or undefined once it no longer exists. */
  botName(botId: string): string | undefined;
  createThread(botId: string, title: string): string | undefined;
  threadExists(botId: string, threadId: string): boolean;
  /** Start the turn through the guarded-send path. */
  startTurn(input: { botId: string; threadId: string; text: string; sendId: string; senderName: string; senderId: string }):
    Promise<{ ok: true } | { ok: false; error: string }>;
  /** Where the request stands, and the bot's closing text once it has one. */
  readRequest(botId: string, threadId: string, sendId: string): { phase: DiscordPhase; reply?: string };
}

export interface DiscordServiceOptions {
  store: DiscordBindingStore;
  host: DiscordHost;
  clientFor?: (binding: DiscordBinding) => DiscordClient;
  pollMs?: number;
  maxWaitMs?: number;
  /** First wait after a failed connect; doubles up to a minute. */
  reconnectMs?: number;
  /** Hard ceiling on a heartbeat interval (the gateway may ask for more). */
  maxHeartbeatMs?: number;
  log?: (message: string) => void;
}

/** Gateway opcodes (docs.discord.com/developers/topics/gateway, 2026-10-11). */
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;
/** DIRECT_MESSAGES intent: MESSAGE_CREATE for the bot's DMs. MESSAGE_CONTENT
 * (privileged) is not required — the gateway still carries content for DMs
 * the bot receives. */
const INTENT_DIRECT_MESSAGES = 1 << 12;

const messageCreateSchema = z.object({
  id: z.string(),
  channel_id: z.string(),
  guild_id: z.string().optional(),
  author: z.object({ id: z.string(), username: z.string().optional(), bot: z.boolean().optional() }).optional(),
  content: z.string().optional(),
});

const pairingCodePattern = /^\d{6}$/;
function pairingCodeFrom(text: string): string | undefined {
  const bare = text.match(/^(\d{6})$/);
  return bare && pairingCodePattern.test(bare[1]!) ? bare[1] : undefined;
}

/** Close codes that will not heal by retrying: the token or the intents are
 * wrong, and an operator must change something. */
const TERMINAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

export class DiscordService {
  private readonly o: Required<Omit<DiscordServiceOptions, "clientFor" | "log">> & Pick<DiscordServiceOptions, "clientFor" | "log">;
  private readonly inflightChats = new Set<string>();
  private readonly pending = new Set<Promise<void>>();
  private readonly sockets = new Map<string, { socket: WebSocket | null; abort: AbortController }>();
  private readonly socketStates = new Map<string, { status: "starting" | "connected" | "reconnecting" | "error" | "stopped"; error?: string; at: number }>();
  private stopped = false;

  constructor(options: DiscordServiceOptions) {
    this.o = { pollMs: 1000, maxWaitMs: 30 * 60_000, reconnectMs: 1000, maxHeartbeatMs: 5 * 60_000, ...options };
  }

  private client(binding: DiscordBinding): DiscordClient {
    return this.o.clientFor?.(binding) ?? createDiscordClient({});
  }

  /** Resolves when every accepted message has been answered (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled(Array.from(this.pending));
  }

  stop(): void {
    this.stopped = true;
    for (const entry of this.sockets.values()) this.close(entry);
  }

  /** Live state of a binding's gateway connection, for the admin API. */
  socketState(bindingId: string): { status: string; error?: string; at: number } | undefined {
    return this.socketStates.get(bindingId);
  }

  /** Start (or no-op) the gateway connection for one binding. An entry left
   * behind by a just-stopped socket is replaced. */
  startSocket(bindingId: string): void {
    if (this.stopped) return;
    const existing = this.sockets.get(bindingId);
    if (existing && !existing.abort.signal.aborted) return;
    this.sockets.delete(bindingId);
    const abort = new AbortController();
    this.sockets.set(bindingId, { socket: null, abort });
    this.socketStates.set(bindingId, { status: "starting", at: Date.now() });
    const loop = this.runSocket(bindingId, abort)
      .catch((error) => {
        this.o.log?.(`discord ${bindingId}: socket crashed: ${error instanceof Error ? error.message : String(error)}`);
        this.socketStates.set(bindingId, { status: "error", error: error instanceof Error ? error.message : String(error), at: Date.now() });
      })
      .finally(() => {
        // Only clean up if we still own the entry (a newer loop may exist).
        if (this.sockets.get(bindingId)?.abort === abort) this.sockets.delete(bindingId);
      });
    void loop;
  }

  stopSocket(bindingId: string): void {
    this.close(this.sockets.get(bindingId));
    this.socketStates.set(bindingId, { status: "stopped", at: Date.now() });
  }

  /** Boot: connect every binding. */
  startAll(): void {
    for (const binding of this.o.store.list()) this.startSocket(binding.id);
  }

  private close(entry: { socket: WebSocket | null; abort: AbortController } | undefined): void {
    if (!entry) return;
    entry.abort.abort();
    try { entry.socket?.close(1000); } catch { /* already closing */ }
  }

  private async runSocket(bindingId: string, abort: AbortController): Promise<void> {
    const { store, reconnectMs } = this.o;
    let backoff = 0;
    while (!this.stopped && !abort.signal.aborted) {
      const binding = store.get(bindingId);
      if (!binding) break; // deleted: done
      const client = this.client(binding);
      try {
        // A fresh URL per (re)connect; also surfaces a dead token early.
        const gateway = await client.getGatewayBot(binding.token);
        const opened = await this.openSocket(gateway.url, binding.token, abort.signal, bindingId);
        const entry = this.sockets.get(bindingId);
        if (entry) entry.socket = opened.socket;
        if (abort.signal.aborted) continue;
        // openSocket only resolves once READY confirmed the session.
        if (opened.user) store.setIdentity(bindingId, opened.user);
        this.socketStates.set(bindingId, { status: "connected", at: Date.now() });
        backoff = 0;
        const ended = await this.session(opened.socket, bindingId, abort.signal, opened.heartbeatMs);
        if (ended.terminal) {
          this.socketStates.set(bindingId, { status: "error", error: ended.error, at: Date.now() });
          break;
        }
        this.socketStates.set(bindingId, { status: "reconnecting", at: Date.now() });
      } catch (error) {
        if (abort.signal.aborted) break;
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof DiscordApiError && error.status === 401) {
          this.socketStates.set(bindingId, { status: "error", error: message, at: Date.now() });
          break;
        }
        this.socketStates.set(bindingId, { status: "reconnecting", error: message, at: Date.now() });
        backoff = backoff ? Math.min(backoff * 2, 60_000) : reconnectMs;
        await this.wait(backoff, abort.signal);
      }
    }
    const state = this.socketStates.get(bindingId);
    // A replaced loop (stopSocket then startSocket) must not overwrite the
    // newer loop's state.
    if (this.sockets.get(bindingId)?.abort === abort && state?.status !== "error") {
      this.socketStates.set(bindingId, { status: "stopped", at: Date.now() });
    }
  }

  /** Connect and identify. Resolves once READY confirms the session (so
   * callers can treat the socket as live), carrying the bot user from READY
   * and the heartbeat interval hello asked for. Refusals reject. */
  private openSocket(url: string, token: string, signal: AbortSignal, bindingId: string): Promise<{ socket: WebSocket; user?: { userId: string; username?: string }; heartbeatMs: number }> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      let ready = false;
      let heartbeatMs = 45_000;
      const timer = setTimeout(() => {
        try { socket.close(); } catch { /* never opened */ }
        reject(new Error(`discord ${bindingId}: gateway did not become ready in 15s`));
      }, 15_000);
      const finish = (error?: Error, user?: { userId: string; username?: string }) => {
        clearTimeout(timer);
        if (ready) return;
        ready = true;
        if (error) reject(error);
        else resolve({ socket, ...(user ? { user } : {}), heartbeatMs: Math.min(heartbeatMs, this.o.maxHeartbeatMs) });
      };
      socket.addEventListener("message", (event) => {
        let payload: { op?: number; t?: string; d?: unknown };
        try { payload = JSON.parse(String(event.data)); } catch { return; }
        if (payload.op === OP_HELLO) {
          const hello = z.object({ heartbeat_interval: z.number() }).safeParse(payload.d);
          if (hello.success) heartbeatMs = hello.data.heartbeat_interval;
          socket.send(JSON.stringify({ op: OP_IDENTIFY, d: { token, intents: INTENT_DIRECT_MESSAGES, properties: { os: process.platform, browser: "Legion", device: "Legion" } } }));
          return;
        }
        if (payload.op === OP_DISPATCH && payload.t === "READY") {
          const parsed = z.object({ user: z.object({ id: z.string(), username: z.string().optional() }) }).safeParse(payload.d);
          finish(undefined, parsed.success ? { userId: parsed.data.user.id, username: parsed.data.user.username } : undefined);
          return;
        }
        if (payload.op === OP_DISPATCH && payload.t === "RESUMED") { finish(); return; }
        if (payload.op === OP_INVALID_SESSION || payload.op === OP_RECONNECT) {
          finish(new Error(`discord ${bindingId}: gateway refused the session`));
          try { socket.close(); } catch { /* already closing */ }
        }
      });
      socket.addEventListener("close", (event) => {
        const code = (event as CloseEvent).code;
        finish(TERMINAL_CLOSE_CODES.has(code) ? new Error(`discord ${bindingId}: gateway closed ${code}`) : new Error("socket closed before ready"));
      }, { once: true });
      socket.addEventListener("error", () => { /* close follows */ });
      signal.addEventListener("abort", () => {
        try { socket.close(1000); } catch { /* never opened */ }
        finish(new Error("aborted"));
      }, { once: true });
    });
  }

  /** The live connection: heartbeats on the interval hello asked for (zombie
   * detection when an ACK is missed) and MESSAGE_CREATE dispatches handed to
   * the guarded-send path. Resolves with how the socket ended. (Hello and
   * READY were already consumed by openSocket.) */
  private session(socket: WebSocket, bindingId: string, signal: AbortSignal, heartbeatMs: number): Promise<{ terminal: boolean; error?: string }> {
    return new Promise((resolve) => {
      let done = false;
      let seq: number | null = null;
      let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
      let awaitingAck = false;
      const finish = (result: { terminal: boolean; error?: string }) => {
        if (done) return;
        done = true;
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
        resolve(result);
      };
      const beat = () => {
        if (done) return;
        if (awaitingAck) {
          // The gateway never confirmed the last heartbeat: a zombied
          // connection — hang up and let the loop reconnect.
          try { socket.close(); } catch { /* already closing */ }
          finish({ terminal: false });
          return;
        }
        awaitingAck = true;
        try { socket.send(JSON.stringify({ op: OP_HEARTBEAT, d: seq })); } catch { /* closing */ }
        heartbeatTimer = setTimeout(beat, heartbeatMs);
      };
      heartbeatTimer = setTimeout(beat, Math.round(heartbeatMs * (0.3 + Math.random() * 0.7)));
      socket.addEventListener("message", (event) => {
        let payload: { op?: number; t?: string; s?: number | null; d?: unknown };
        try { payload = JSON.parse(String(event.data)); } catch { return; }
        if (typeof payload.s === "number") seq = payload.s;
        if (payload.op === OP_HEARTBEAT_ACK) { awaitingAck = false; return; }
        if (payload.op === OP_HEARTBEAT) {
          // The gateway may request an immediate heartbeat; reply at once.
          try { socket.send(JSON.stringify({ op: OP_HEARTBEAT, d: seq })); } catch { /* closing */ }
          return;
        }
        if (payload.op === OP_INVALID_SESSION || payload.op === OP_RECONNECT) {
          try { socket.close(); } catch { /* already closing */ }
          finish({ terminal: false });
          return;
        }
        if (payload.op !== OP_DISPATCH) return;
        if (payload.t !== "MESSAGE_CREATE") return;
        const parsed = messageCreateSchema.safeParse(payload.d);
        if (parsed.success && !parsed.data.guild_id) this.dispatch(bindingId, parsed.data);
      });
      socket.addEventListener("close", (event) => {
        const code = (event as CloseEvent).code;
        finish(TERMINAL_CLOSE_CODES.has(code)
          ? { terminal: true, error: `Discord closed the gateway (${code}) — check the bot token and intents` }
          : { terminal: false });
      }, { once: true });
      socket.addEventListener("error", () => { /* close follows */ });
      signal.addEventListener("abort", () => {
        try { socket.close(1000); } catch { /* already closing */ }
        finish({ terminal: false });
      }, { once: true });
    });
  }

  /** Shared inbound path: DM text turns (and pairing codes) run; everything
   * else (guild messages, the bot's own echoes, other events) is ignored.
   * Fire-and-forget: the gateway loop must not wait half an hour for a turn.
   * The binding is re-read so a chat paired between dispatches is seen with
   * its fresh state. */
  private dispatch(bindingId: string, event: z.infer<typeof messageCreateSchema>): Promise<void> | null {
    if (event.author?.bot) return null;
    const work = this.process(bindingId, event)
      .catch((error) => this.o.log?.(`discord ${bindingId}: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => this.pending.delete(work));
    this.pending.add(work);
    return work;
  }

  private async process(bindingId: string, event: z.infer<typeof messageCreateSchema>): Promise<void> {
    const { store, host } = this.o;
    const binding = store.get(bindingId);
    if (!binding) return;
    if (event.author && binding.userId && event.author.id === binding.userId) return;
    const channelId = event.channel_id;
    const text = event.content?.trim() ?? "";
    const person = event.author?.username ? `@${event.author.username}` : channelId;
    const client = this.client(binding);
    const say = (reply: string) => client.sendText(binding.token, channelId, reply).catch(() => 0);
    const botName = host.botName(binding.botId);
    if (!botName) return;

    const chat = binding.chats[channelId];
    if (!chat) {
      const code = pairingCodeFrom(text);
      if (!code && !store.pairingActive(binding.id)) {
        await say("This chat isn't paired with a bot yet. Ask its owner for a pairing code and send it here.");
        return;
      }
      if (!code || !store.tryPairingCode(binding.id, code)) {
        await say("That code didn't match, or it has expired. Ask the owner for a new one.");
        return;
      }
      const threadId = host.createThread(binding.botId, `Discord · ${person}`);
      if (!threadId) return;
      store.bindChat(binding.id, channelId, { threadId, name: person, ...(event.author ? { userId: `discord:${event.author.id}` } : {}) });
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
        const fresh = host.createThread(binding.botId, `Discord · ${person}`);
        if (!fresh) return;
        threadId = fresh;
        store.bindChat(binding.id, channelId, { threadId, name: person, ...(event.author ? { userId: `discord:${event.author.id}` } : {}) });
      }
      await this.relay(binding, client, channelId, threadId, text, event.id, event.author);
    } finally {
      this.inflightChats.delete(key);
    }
  }

  private async relay(binding: DiscordBinding, client: DiscordClient, channelId: string, threadId: string, text: string, messageId: string,
    author: { id: string; username?: string } | undefined): Promise<void> {
    const { host, pollMs, maxWaitMs } = this.o;
    // Deterministic, so Discord redelivering an event (or a restart) cannot start the turn twice.
    const sendId = `dc-${createHash("sha256").update(binding.id).digest("hex").slice(0, 12)}-${messageId}`;
    let lastTyping = 0;
    const typing = () => {
      if (Date.now() - lastTyping < 8000) return;
      lastTyping = Date.now();
      void client.triggerTyping(binding.token, channelId).catch(() => undefined);
    };
    typing();
    const started = await host.startTurn({
      botId: binding.botId, threadId, text, sendId,
      senderName: author?.username ? `@${author.username}` : "Discord",
      senderId: `discord:${author?.id ?? channelId}`,
    });
    if (!started.ok) { await client.createMessage(binding.token, channelId, started.error).catch(() => undefined); return; }

    const deadline = Date.now() + maxWaitMs;
    let notifiedWaiting = false;
    let untrackedPolls = 0;
    while (!this.stopped && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      let state: ReturnType<DiscordHost["readRequest"]>;
      try { state = host.readRequest(binding.botId, threadId, sendId); }
      catch { state = { phase: "untracked" }; }
      untrackedPolls = state.phase === "untracked" ? untrackedPolls + 1 : 0;
      if (state.phase === "settled" || (state.phase === "untracked" && untrackedPolls >= 3)) {
        if (state.reply?.trim()) await client.sendText(binding.token, channelId, state.reply).catch(() => 0);
        else await client.createMessage(binding.token, channelId, state.phase === "settled" ? "(The bot finished without a text reply.)" : "That turn didn't finish. Open the app to see what happened.").catch(() => undefined);
        return;
      }
      if (state.phase === "waiting") {
        if (!notifiedWaiting) { notifiedWaiting = true; await client.createMessage(binding.token, channelId, "The bot needs your approval in Legion to continue.").catch(() => undefined); }
      } else typing();
    }
    if (!this.stopped) await client.createMessage(binding.token, channelId, "The bot is still working. Check the app for the result.").catch(() => undefined);
  }

  private wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
}
