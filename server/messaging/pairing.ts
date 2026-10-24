// Pairing machinery shared by every messaging adapter: a chat that is not yet
// bound proves ownership by sending a fresh single-use 6-digit code that only
// the bot's owner can read out of the admin UI. Codes expire quickly and burn
// after repeated misses so a six-digit secret cannot be ground down.
import { createHash, randomInt, timingSafeEqual } from "node:crypto";

export const PAIRING_TTL_MS = 10 * 60_000;
/** Wrong codes an unknown chat may send before the active code is burned. */
export const PAIRING_MAX_FAILURES = 10;

export interface PairingState { code: string; expiresAt: number; failures: number }

/** Constant-time string equality (equal-length digests, so lengths do not leak). */
export function safeEqual(a: string, b: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

export function newPairing(now: () => number): PairingState {
  return { code: String(randomInt(0, 1_000_000)).padStart(6, "0"), expiresAt: now() + PAIRING_TTL_MS, failures: 0 };
}

/** Spend an attempt against `pairing` (failures mutated in place; the caller
 * persists). A match consumes the code (single use); an expiry or enough
 * misses burns it, so the caller stops accepting anything against it. */
export function tryPairing(pairing: PairingState, candidate: string, now: () => number): { matched: boolean; burned: boolean } {
  if (pairing.expiresAt <= now()) return { matched: false, burned: true };
  if (safeEqual(pairing.code, candidate)) return { matched: true, burned: true };
  pairing.failures += 1;
  return { matched: false, burned: pairing.failures >= PAIRING_MAX_FAILURES };
}
