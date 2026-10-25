// Telegram bindings, kept in <data dir>/messaging/telegram.json (mode 0600:
// it holds bot tokens). One binding ties one Legion bot to one Telegram
// bot; the chats that may talk to it (and the task each one lands in) hang off
// the binding. Loaded once, saved atomically on every change.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";
import { newPairing, tryPairing } from "./pairing.ts";

export { PAIRING_MAX_FAILURES, PAIRING_TTL_MS, safeEqual } from "./pairing.ts";


const chatSchema = z.object({
  threadId: z.string(),
  enabled: z.boolean(),
  name: z.string().optional(),
  pairedAt: z.number(),
});
const bindingSchema = z.object({
  id: z.string().regex(/^tg_[A-Za-z0-9_-]+$/),
  botId: z.string(),
  token: z.string().min(1),
  secret: z.string().min(1),
  username: z.string().optional(),
  markdown: z.boolean().optional(),
  createdAt: z.number(),
  chats: z.record(z.string(), chatSchema),
  pairing: z.object({ code: z.string(), expiresAt: z.number(), failures: z.number() }).optional(),
  /** Older adapters omit this field for both transports; resolve through
   * Telegram webhook status before starting delivery. */
  transport: z.enum(["poll", "webhook"]).optional(),
  /** Last confirmed getUpdates cursor (all updates ≤ it are delivered). */
  pollOffset: z.number().int().nonnegative().optional(),
});
const fileSchema = z.object({ bindings: z.record(z.string(), bindingSchema) });

export type TelegramChat = z.infer<typeof chatSchema>;
export type TelegramBinding = z.infer<typeof bindingSchema>;

export class TelegramBindingStore {
  private readonly file: string;
  private readonly now: () => number;
  private bindings = new Map<string, TelegramBinding>();

  constructor(dataDir: string, now: () => number = Date.now) {
    this.now = now;
    this.file = join(dataDir, "messaging", "telegram.json");
    if (!existsSync(this.file)) return;
    try {
      const parsed = fileSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
      this.bindings = new Map(Object.entries(parsed.bindings));
    } catch (error) {
      // Never silently start empty over a file we could not read: the next
      // save would overwrite every token with nothing.
      throw new Error(`messaging: cannot read ${this.file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify({ bindings: Object.fromEntries(this.bindings) }, null, 2), { mode: 0o600 });
  }

  list(): TelegramBinding[] { return [...this.bindings.values()].map((b) => structuredClone(b)); }

  get(id: string): TelegramBinding | undefined {
    const found = this.bindings.get(id);
    return found ? structuredClone(found) : undefined;
  }

  create(input: { botId: string; token: string; username?: string; markdown?: boolean; transport?: "poll" | "webhook" }): TelegramBinding {
    const binding: TelegramBinding = {
      id: `tg_${randomBytes(9).toString("base64url")}`,
      botId: input.botId,
      token: input.token,
      // Telegram's secret_token alphabet is A-Za-z0-9_- , 1-256 chars.
      secret: randomBytes(32).toString("base64url"),
      ...(input.username ? { username: input.username } : {}),
      ...(input.markdown ? { markdown: true } : {}),
      transport: input.transport ?? "poll",
      createdAt: this.now(),
      chats: {},
    };
    this.bindings.set(binding.id, binding);
    this.save();
    return structuredClone(binding);
  }

  /** Switch how Telegram delivers updates. Moving to poll clears the stale
   * webhook registration's cursor state; moving to webhook keeps the offset
   * so a later switch back resumes where polling left off. */
  setTransport(id: string, transport: "poll" | "webhook"): boolean {
    const binding = this.bindings.get(id);
    if (!binding) return false;
    binding.transport = transport;
    this.save();
    return true;
  }

  /** Confirm delivery through `offset` (all updates ≤ it are done). */
  setPollOffset(id: string, offset: number): void {
    const binding = this.bindings.get(id);
    if (!binding) return;
    binding.pollOffset = offset;
    this.save();
  }

  remove(id: string): boolean {
    const removed = this.bindings.delete(id);
    if (removed) this.save();
    return removed;
  }

  /** A fresh single-use 6-digit code, replacing any earlier one. */
  startPairing(id: string): { code: string; expiresAt: number } | undefined {
    const binding = this.bindings.get(id);
    if (!binding) return undefined;
    const pairing = newPairing(this.now);
    binding.pairing = pairing;
    this.save();
    return { code: pairing.code, expiresAt: pairing.expiresAt };
  }

  pairingActive(id: string): boolean {
    const pairing = this.bindings.get(id)?.pairing;
    return Boolean(pairing && pairing.expiresAt > this.now());
  }

  /** Spend an attempt. A match consumes the code (single use); too many
   * misses burn it so a six-digit code cannot be ground down. */
  tryPairingCode(id: string, candidate: string): boolean {
    const binding = this.bindings.get(id);
    const pairing = binding?.pairing;
    if (!binding || !pairing) return false;
    const attempt = tryPairing(pairing, candidate, this.now);
    if (attempt.burned) delete binding.pairing;
    this.save();
    return attempt.matched;
  }

  bindChat(id: string, chatId: string, chat: { threadId: string; name?: string }): void {
    const binding = this.bindings.get(id);
    if (!binding) return;
    binding.chats[chatId] = { threadId: chat.threadId, enabled: true, pairedAt: this.now(), ...(chat.name ? { name: chat.name } : {}) };
    this.save();
  }

  setChatEnabled(id: string, chatId: string, enabled: boolean): boolean {
    const chat = this.bindings.get(id)?.chats[chatId];
    if (!chat) return false;
    chat.enabled = enabled;
    this.save();
    return true;
  }

  removeChat(id: string, chatId: string): boolean {
    const binding = this.bindings.get(id);
    if (!binding || !(chatId in binding.chats)) return false;
    delete binding.chats[chatId];
    this.save();
    return true;
  }
}
