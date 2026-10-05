import { createHash } from "node:crypto";
import { chmodSync, closeSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/** JSON normalization preserves values and array order, sorting object keys. */
function canonical(value: unknown): string {
  const json = JSON.stringify(value) ?? "null";
  const sort = (item: any): any => Array.isArray(item) ? item.map(sort)
    : item && typeof item === "object" ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])])) : item;
  return JSON.stringify(sort(JSON.parse(json)));
}

export function effectKey(input: { botId: string; tool: string; args: unknown; threadId: string; turnId: string }): string {
  if (!input.botId || !input.tool || !input.threadId || !input.turnId) throw new Error("Effect identity requires bot, tool, thread and turn");
  return createHash("sha256").update(canonical([input.botId, input.tool, input.args, input.threadId, input.turnId])).digest("hex");
}

/** Claims authorize dispatch, not successful completion. Never release an
 * uncertain claim: the remote side may already have applied the effect. */
export class EffectLedger {
  private db?: DatabaseSync;
  private failure?: Error;
  constructor(path: string) {
    try {
      closeSync(openSync(path, "a", 0o600));
      chmodSync(path, 0o600);
      this.db = new DatabaseSync(path);
      this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS effects (key TEXT PRIMARY KEY, claimed_at TEXT NOT NULL)");
    } catch {
      this.failure = new Error("Effect ledger is unavailable; no consequential action was authorized");
    }
  }
  private database(): DatabaseSync {
    if (this.failure || !this.db) throw this.failure ?? new Error("Effect ledger closed");
    return this.db;
  }
  has(key: string): boolean {
    return Boolean(this.database().prepare("SELECT 1 FROM effects WHERE key = ?").get(key));
  }
  claim(key: string): boolean { return this.claimAll([key]); }
  claimAll(keys: string[]): boolean {
    if (!keys.length || keys.some(key => !/^[a-f0-9]{64}$/.test(key))) throw new Error("Invalid effect key");
    const db = this.database();
    db.exec("BEGIN IMMEDIATE");
    try {
      const insert = db.prepare("INSERT OR IGNORE INTO effects (key, claimed_at) VALUES (?, ?)");
      for (const key of keys) {
        if (insert.run(key, new Date().toISOString()).changes !== 1) { db.exec("ROLLBACK"); return false; }
      }
      db.exec("COMMIT");
      return true;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  close(): void { this.db?.close(); this.db = undefined; }
}
