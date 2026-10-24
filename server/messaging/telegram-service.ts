// Telegram inbound/outbound for a bound OpenMausBot bot: validates the webhook
// secret, pairs unknown chats by code, hands each message to the host's
// guarded-send path (so approval semantics are unchanged), keeps "typing" up
// while the turn runs, and sends the bot's reply back, split to Telegram's
// 4096-character limit. The host (server/index.ts) supplies everything that
// touches bots and threads; this module never imports it.
import { createHash } from "node:crypto";
import { z } from "zod";

import type { JsonValue } from "../schema.ts";

import { safeEqual, type TelegramBinding, type TelegramBindingStore } from "./telegram-store.ts";
import { createTelegramClient, TelegramApiError, TelegramPollAborted, type TelegramClient } from "./telegram.ts";

export type TelegramPhase = "working" | "waiting" | "settled" | "untracked";

export interface TelegramHost {
  /** The bot's display name, or undefined once it no longer exists. */
  botName(botId: string): string | undefined;
  createThread(botId: string, title: string): string | undefined;
  threadExists(botId: string, threadId: string): boolean;
  /** Start the turn through the guarded-send path. */
  startTurn(input: { botId: string; threadId: string; text: string; sendId: string; senderName: string; senderId: string }):
    Promise<{ ok: true } | { ok: false; error: string }>;
  /** Where the request stands, and the bot's closing text once it has one. */
  readRequest(botId: string, threadId: string, sendId: string): { phase: TelegramPhase; reply?: string };
}

export interface TelegramServiceOptions {
  store: TelegramBindingStore;
  host: TelegramHost;
  clientFor?: (binding: TelegramBinding) => TelegramClient;
  pollMs?: number;
  typingMs?: number;
  maxWaitMs?: number;
  /** getUpdates long-poll hold, seconds (Bot API caps at 50). */
  getUpdatesTimeoutS?: number;
  /** First wait after a failed poll round; doubles up to a minute. */
  backoffMs?: number;
  log?: (message: string) => void;
}

const updateSchema = z.object({
  update_id: z.number().int(),
  message: z.object({
    message_id: z.number().int(),
    text: z.string().optional(),
    chat: z.object({
      id: z.number(),
      type: z.string(),
      first_name: z.string().optional(),
      username: z.string().optional(),
    }),
    from: z.object({ id: z.number(), is_bot: z.boolean().optional(), first_name: z.string().optional(), username: z.string().optional() }).optional(),
  }).optional(),
});
type Update = z.infer<typeof updateSchema>;
type Message = NonNullable<Update["message"]>;

export interface TelegramReceipt { status: number; body: Record<string, JsonValue> }

const pairingCodePattern = /^\d{6}$/;
function pairingCodeFrom(text: string): string | undefined {
  const bare = text.match(/^(?:\/start(?:@\w+)?\s+)?(\d{6})$/);
  return bare && pairingCodePattern.test(bare[1]!) ? bare[1] : undefined;
}

export class TelegramService {
  private readonly o: Required<Omit<TelegramServiceOptions, "clientFor" | "log">> & Pick<TelegramServiceOptions, "clientFor" | "log">;
  private readonly seen = new Map<string, number[]>();
  private readonly inflightChats = new Set<string>();
  private readonly pending = new Set<Promise<void>>();
  private readonly pollers = new Map<string, { abort: AbortController }>();
  private readonly pollerStates = new Map<string, { status: "starting" | "polling" | "backing-off" | "error" | "stopped"; error?: string; at: number }>();
  private readonly webhookCleared = new Set<string>();
  private stopped = false;

  constructor(options: TelegramServiceOptions) {
    this.o = { pollMs: 1000, typingMs: 4000, maxWaitMs: 30 * 60_000, getUpdatesTimeoutS: 50, backoffMs: 1000, ...options };
  }

  private client(binding: TelegramBinding): TelegramClient {
    return this.o.clientFor?.(binding) ?? createTelegramClient({ token: binding.token });
  }

  /** Resolves when every accepted message has been answered (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled(Array.from(this.pending));
  }

  stop(): void {
    this.stopped = true;
    for (const poller of this.pollers.values()) poller.abort.abort();
  }

  /** The webhook entry point. Answers Telegram at once; the turn runs on. */
  receive(bindingId: string, secretHeader: string | undefined, raw: unknown): TelegramReceipt {
    const binding = this.o.store.get(bindingId);
    // Unknown binding and wrong secret answer identically, after the same compare.
    const secretOk = safeEqual(secretHeader ?? "", binding?.secret ?? "\0no-binding");
    if (!binding || !secretOk) return { status: 401, body: { error: "Invalid Telegram webhook secret" } };
    const parsed = updateSchema.safeParse(raw);
    if (!parsed.success) return { status: 400, body: { error: "Unreadable Telegram update" } };
    const update = parsed.data;
    const recent = this.seen.get(binding.id) ?? [];
    if (recent.includes(update.update_id)) return { status: 200, body: { ok: true, duplicate: true } };
    this.seen.set(binding.id, [...recent.slice(-199), update.update_id]);
    return this.dispatch(binding, update)
      ? { status: 200, body: { ok: true } }
      : { status: 200, body: { ok: true, ignored: true } };
  }

  /** Shared inbound path: private-chat text turns (and pairing codes) run;
   * everything else is ignored. Returns null when the update carried no
   * work, else the running work promise (dispatch is fire-and-forget: the
   * caller — Telegram's webhook answer or the poll loop's offset advance —
   * must not wait half an hour for a turn). The binding is re-read so a
   * chat paired between poll rounds is seen with its fresh state. */
  private dispatch(binding: TelegramBinding, update: Update): Promise<void> | null {
    const current = this.o.store.get(binding.id) ?? binding;
    const message = update.message;
    if (!message || message.chat.type !== "private" || message.from?.is_bot) return null;
    const work = this.process(current, message, update.update_id)
      .catch((error) => this.o.log?.(`telegram ${binding.id}: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => this.pending.delete(work));
    this.pending.add(work);
    return work;
  }

  // ---- getUpdates long-polling (the default inbound transport; no public URL) ----

  /** Live state of a binding's poller, for the admin API. */
  pollerState(bindingId: string): { status: string; error?: string; at: number } | undefined {
    return this.pollerStates.get(bindingId);
  }

  /** Start (or no-op) the poller for one binding. */
  startPolling(bindingId: string): void {
    if (this.stopped || (this.pollers.has(bindingId) && !this.pollers.get(bindingId)!.abort.signal.aborted)) return;
    const abort = new AbortController();
    this.pollers.set(bindingId, { abort });
    this.pollerStates.set(bindingId, { status: "starting", at: Date.now() });
    const loop = this.runPoller(bindingId, abort)
      .catch((error) => {
        if (this.stopped || abort.signal.aborted) return;
        this.o.log?.(`telegram ${bindingId}: poller crashed: ${error instanceof Error ? error.message : String(error)}`);
        this.pollerStates.set(bindingId, { status: "error", error: error instanceof Error ? error.message : String(error), at: Date.now() });
      });
    void loop;
  }

  stopPolling(bindingId: string): void {
    this.pollers.get(bindingId)?.abort.abort();
    this.pollerStates.set(bindingId, { status: "stopped", at: Date.now() });
  }

  /** Boot: poll every binding that is not on webhook delivery. */
  startAll(): void {
    for (const binding of this.o.store.list()) {
      if (binding.transport !== "webhook") this.startPolling(binding.id);
    }
  }

  private async runPoller(bindingId: string, abort: AbortController): Promise<void> {
    const { store, getUpdatesTimeoutS, backoffMs } = this.o;
    let backoff = 0;
    try {
      const legacy = store.get(bindingId);
      if (legacy && !legacy.transport) {
        try {
          const info = await this.client(legacy).getWebhookInfo(abort.signal);
          if (this.stopped || abort.signal.aborted) return;
          const current = store.get(bindingId);
          if (!current) return;
          if (!current.transport) {
            store.setTransport(bindingId, info.url ? "webhook" : "poll");
            if (!info.url) this.webhookCleared.add(bindingId);
          }
        } catch (error) {
          if (this.stopped || abort.signal.aborted) return;
          const detail = (error instanceof Error ? error.message : String(error)).split(legacy.token).join("<token>");
          this.pollerStates.set(bindingId, { status: "error", error: detail, at: Date.now() });
          this.o.log?.(`telegram ${bindingId}: transport discovery failed: ${detail}`);
          return;
        }
      }
      while (!this.stopped && !abort.signal.aborted) {
        const binding = store.get(bindingId);
        // Deleted, or switched to webhook delivery: the poller's job is done.
        if (!binding || binding.transport === "webhook") break;
        const client = this.client(binding);
        try {
          // getUpdates and a webhook are mutually exclusive per token; clear
          // any registration once per poller so the first poll cannot 409.
          if (!this.webhookCleared.has(bindingId)) {
            await client.deleteWebhook();
            if (this.stopped || abort.signal.aborted) return;
            this.webhookCleared.add(bindingId);
          }
          let offset = binding.pollOffset ?? 0;
          this.pollerStates.set(bindingId, { status: "polling", at: Date.now() });
          // Telegram confirms update N by the next call asking for N + 1.
          const updates = await client.getUpdates(offset + 1, getUpdatesTimeoutS, abort.signal);
          for (const update of updates) {
            if (update.update_id <= offset) continue;
            const parsed = updateSchema.safeParse(update);
            if (parsed.success) this.dispatch(binding, parsed.data);
            offset = update.update_id;
            store.setPollOffset(bindingId, offset);
          }
          backoff = 0;
        } catch (error) {
          if (abort.signal.aborted || error instanceof TelegramPollAborted) break;
          const waitMs = this.pollerWaitMs(error, () => (backoff = backoff ? Math.min(backoff * 2, 60_000) : backoffMs));
          this.pollerStates.set(bindingId, { status: waitMs.state, error: error instanceof Error ? error.message : String(error), at: Date.now() });
          if (waitMs.state === "error") break; // e.g. a webhook is active elsewhere; needs an explicit change
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, waitMs.ms);
            abort.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
          });
        }
      }
    } finally {
      if (this.pollers.get(bindingId)?.abort === abort) {
        this.pollers.delete(bindingId);
        const state = this.pollerStates.get(bindingId);
        if (state?.status !== "error") this.pollerStates.set(bindingId, { status: "stopped", at: Date.now() });
      }
    }
  }

  /** How long to wait after a failed round, and whether to keep going. */
  private pollerWaitMs(error: unknown, grow: () => number): { ms: number; state: "backing-off" | "error" } {
    if (error instanceof TelegramApiError) {
      // Another registration owns the token's updates; polling here cannot start.
      if (error.status === 409) return { ms: 0, state: "error" };
      if (error.status === 429) {
        const retryAfter = Number(/after (\d+)/.exec(error.message)?.[1]);
        return { ms: Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 60_000) : grow(), state: "backing-off" };
      }
    }
    return { ms: grow(), state: "backing-off" };
  }

  private async process(binding: TelegramBinding, message: Message, updateId: number): Promise<void> {
    const { store, host } = this.o;
    const client = this.client(binding);
    const chatId = String(message.chat.id);
    const text = message.text?.trim() ?? "";
    const person = message.chat.first_name ?? (message.chat.username ? `@${message.chat.username}` : chatId);
    const say = (reply: string) => client.sendText(chatId, reply).catch(() => 0);
    const botName = host.botName(binding.botId);
    if (!botName) return;

    const chat = binding.chats[chatId];
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
      const threadId = host.createThread(binding.botId, `Telegram · ${person}`);
      if (!threadId) return;
      store.bindChat(binding.id, chatId, { threadId, name: person });
      await say(`Paired with ${botName}. Send a message to start.`);
      return;
    }
    if (!chat.enabled) return;
    if (/^\/start(?:@\w+)?$/.test(text)) { await say(`Connected to ${botName}. Send a message to start.`); return; }
    if (!text) { await say("Only text messages are supported for now."); return; }

    const key = `${binding.id}:${chatId}`;
    if (this.inflightChats.has(key)) { await say("Still working on your previous message. I'll answer it first."); return; }
    this.inflightChats.add(key);
    try {
      let threadId = chat.threadId;
      if (!host.threadExists(binding.botId, threadId)) {
        const fresh = host.createThread(binding.botId, `Telegram · ${person}`);
        if (!fresh) return;
        threadId = fresh;
        store.bindChat(binding.id, chatId, { threadId, name: person });
      }
      await this.relay(binding, client, chatId, threadId, text, updateId, message.from);
    } finally {
      this.inflightChats.delete(key);
    }
  }

  private async relay(binding: TelegramBinding, client: TelegramClient, chatId: string, threadId: string, text: string,
    updateId: number, from: Message["from"]): Promise<void> {
    const { host, pollMs, typingMs, maxWaitMs } = this.o;
    const send = (reply: string) => client.sendText(chatId, reply, { markdown: binding.markdown === true });
    const plain = (reply: string) => client.sendText(chatId, reply).catch(() => 0);
    // Deterministic, so Telegram redelivering an update (or a restart) cannot start the turn twice.
    const sendId = `tg-${createHash("sha256").update(binding.id).digest("hex").slice(0, 12)}-${updateId}`;
    let lastTyping = 0;
    const typing = () => {
      if (Date.now() - lastTyping < typingMs) return;
      lastTyping = Date.now();
      void client.sendChatAction(chatId, "typing").catch(() => undefined);
    };
    typing();
    const started = await host.startTurn({
      botId: binding.botId, threadId, text, sendId,
      senderName: from?.first_name ?? (from?.username ? `@${from.username}` : "Telegram"),
      senderId: `telegram:${from?.id ?? chatId}`,
    });
    if (!started.ok) { await plain(started.error); return; }

    const deadline = Date.now() + maxWaitMs;
    let notifiedWaiting = false;
    let untrackedPolls = 0;
    while (!this.stopped && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      let state: ReturnType<TelegramHost["readRequest"]>;
      try { state = host.readRequest(binding.botId, threadId, sendId); }
      catch { state = { phase: "untracked" }; }
      untrackedPolls = state.phase === "untracked" ? untrackedPolls + 1 : 0;
      if (state.phase === "settled" || (state.phase === "untracked" && untrackedPolls >= 3)) {
        if (state.reply?.trim()) await send(state.reply);
        else await plain(state.phase === "settled" ? "(The bot finished without a text reply.)" : "That turn didn't finish. Open the app to see what happened.");
        return;
      }
      if (state.phase === "waiting") {
        if (!notifiedWaiting) { notifiedWaiting = true; await plain("The bot needs your approval in OpenMausBot to continue."); }
      } else typing();
    }
    if (!this.stopped) await plain("The bot is still working. Check the app for the result.");
  }
}
