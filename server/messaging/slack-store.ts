// Slack bindings, kept in <data dir>/messaging/slack.json (mode 0600: it holds
// an app-level token and a bot token per binding). One binding ties one
// Legion bot to one Slack app; the DM conversations that may talk to it
// (and the task each one lands in) hang off the binding. Loaded once, saved
// atomically on every change. Pairing machinery is shared (see pairing.ts).
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";
import { newPairing, tryPairing } from "./pairing.ts";

const chatSchema = z.object({
  threadId: z.string(),
  enabled: z.boolean(),
  name: z.string().optional(),
  /** The Slack user behind the DM, when known (format: "slack:U…"). */
  userId: z.string().optional(),
  pairedAt: z.number(),
});
const bindingSchema = z.object({
  id: z.string().regex(/^sl_[A-Za-z0-9_-]+$/),
  botId: z.string(),
  /** App-level token (xapp-…) with connections:write, for Socket Mode. */
  appToken: z.string().min(1),
  /** Bot token (xoxb-…) with chat:write + im:history, for API calls. */
  botToken: z.string().min(1),
  teamId: z.string().optional(),
  teamName: z.string().optional(),
  /** The app's bot user id (from auth.test), used to skip its own echoes. */
  botUserId: z.string().optional(),
  botName: z.string().optional(),
  createdAt: z.number(),
  chats: z.record(z.string(), chatSchema),
  pairing: z.object({ code: z.string(), expiresAt: z.number(), failures: z.number() }).optional(),
});
const fileSchema = z.object({ bindings: z.record(z.string(), bindingSchema) });

export type SlackChat = z.infer<typeof chatSchema>;
export type SlackBinding = z.infer<typeof bindingSchema>;

export class SlackBindingStore {
  private readonly file: string;
  private readonly now: () => number;
  private bindings = new Map<string, SlackBinding>();

  constructor(dataDir: string, now: () => number = Date.now) {
    this.now = now;
    this.file = join(dataDir, "messaging", "slack.json");
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

  list(): SlackBinding[] { return [...this.bindings.values()].map((b) => structuredClone(b)); }

  get(id: string): SlackBinding | undefined {
    const found = this.bindings.get(id);
    return found ? structuredClone(found) : undefined;
  }

  create(input: { botId: string; appToken: string; botToken: string; teamId?: string; teamName?: string; botUserId?: string; botName?: string }): SlackBinding {
    const binding: SlackBinding = {
      id: `sl_${randomBytes(9).toString("base64url")}`,
      botId: input.botId,
      appToken: input.appToken,
      botToken: input.botToken,
      ...(input.teamId ? { teamId: input.teamId } : {}),
      ...(input.teamName ? { teamName: input.teamName } : {}),
      ...(input.botUserId ? { botUserId: input.botUserId } : {}),
      ...(input.botName ? { botName: input.botName } : {}),
      createdAt: this.now(),
      chats: {},
    };
    this.bindings.set(binding.id, binding);
    this.save();
    return structuredClone(binding);
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

  bindChat(id: string, channelId: string, chat: { threadId: string; name?: string; userId?: string }): void {
    const binding = this.bindings.get(id);
    if (!binding) return;
    binding.chats[channelId] = {
      threadId: chat.threadId,
      enabled: true,
      pairedAt: this.now(),
      ...(chat.name ? { name: chat.name } : {}),
      ...(chat.userId ? { userId: chat.userId } : {}),
    };
    this.save();
  }

  setChatEnabled(id: string, channelId: string, enabled: boolean): boolean {
    const chat = this.bindings.get(id)?.chats[channelId];
    if (!chat) return false;
    chat.enabled = enabled;
    this.save();
    return true;
  }

  removeChat(id: string, channelId: string): boolean {
    const binding = this.bindings.get(id);
    if (!binding || !(channelId in binding.chats)) return false;
    delete binding.chats[channelId];
    this.save();
    return true;
  }
}
