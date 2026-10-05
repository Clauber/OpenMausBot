import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EffectLedger, effectKey } from "./effect-ledger.ts";

describe("effect idempotency", () => {
  const input = { botId: "bot", tool: "GMAIL_SEND_EMAIL", args: { to: "fixture@example.com", body: "hello" }, threadId: "thread", turnId: "turn" };
  it("canonicalizes object order without conflating turns, bots, arrays or values", () => {
    const key = effectKey(input);
    expect(key).toBe(effectKey({ ...input, args: { body: "hello", to: "fixture@example.com" } }));
    for (const patch of [{ botId: "other" }, { turnId: "other" }, { threadId: "other" }, { tool: "SLACK_SEND" }, { args: [1, 2] }, { args: { body: " hello" } }]) expect(effectKey({ ...input, ...patch })).not.toBe(key);
    expect(effectKey({ ...input, args: [1, 2] })).not.toBe(effectKey({ ...input, args: [2, 1] }));
    expect(() => effectKey({ ...input, turnId: "" })).toThrow();
  });
  it("claims once across connections and restarts, keeping private storage", () => {
    const dir = mkdtempSync(join(tmpdir(), "legion-effects-"));
    const path = join(dir, "effects.sqlite");
    const key = effectKey(input);
    const a = new EffectLedger(path);
    const b = new EffectLedger(path);
    try {
      expect(a.claim(key)).toBe(true);
      expect(b.claim(key)).toBe(false);
      a.close();
      const restored = new EffectLedger(path);
      expect(restored.has(key)).toBe(true);
      expect(restored.claim(key)).toBe(false);
      restored.close();
      if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it("claims a batch atomically without retaining a partial claim", () => {
    const dir = mkdtempSync(join(tmpdir(), "legion-effects-"));
    const ledger = new EffectLedger(join(dir, "effects.sqlite"));
    const first = effectKey(input), second = effectKey({ ...input, tool: "SLACK_SEND_MESSAGE" });
    try {
      expect(ledger.claim(first)).toBe(true);
      expect(ledger.claimAll([second, first])).toBe(false);
      expect(ledger.has(second)).toBe(false);
    } finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it("fails closed on corrupted storage and invalid keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "legion-effects-"));
    const path = join(dir, "effects.sqlite");
    writeFileSync(path, "corrupt");
    const ledger = new EffectLedger(path);
    try { expect(() => ledger.claim(effectKey(input))).toThrow(); expect(() => ledger.has(effectKey(input))).toThrow(); }
    finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
