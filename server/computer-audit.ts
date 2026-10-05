// Per-computer audit trail: an append-only record of what a bot (or the owner)
// did to a computer, never of what it typed. A row names the tool, the outcome
// and the timing — not the coordinates, text, URL or shell command — so the
// log can be shown to anyone who may see the computer without leaking what was
// typed into it. Error summaries are redacted and cut short for the same
// reason.
//
// One NDJSON file per computer under <data>/computer-audit/, mode 0600. Each
// file is trimmed to the newest `cap` rows (default 5000) once it grows past
// cap + slack, so retention is bounded without rewriting on every append.
// Writes are synchronous and never throw: an audit failure must not take
// down the action it records.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ComputerRevokedError, type ComputerEpochs } from "./computer-epoch.ts";
import { redactSecretsInText } from "./redact.ts";

export type AuditActor = "bot" | "owner";
export type AuditOutcome = "ok" | "denied" | "error";

export interface ComputerAuditRow {
  ts: number;
  computerId: string;
  botId: string;
  actor: AuditActor;
  /** Tool name, `takeover.*` event or `files.*` operation. Never arguments. */
  action: string;
  outcome: AuditOutcome;
  durationMs: number;
  /** Redacted, short reason for a denied or failed row. */
  error?: string;
}

export interface AuditQuery {
  botId?: string;
  action?: string;
  outcome?: AuditOutcome;
  limit?: number;
}

export const DEFAULT_AUDIT_CAP = 5000;
const MAX_SLACK = 250;
const MAX_ERROR_CHARS = 200;
const SAFE_ID = /[^\w.-]/g;

export class ComputerAuditLog {
  private readonly dir: string;
  private readonly counts = new Map<string, number>();

  private readonly slack: number;
  private readonly cap: number;

  constructor(dataDir: string, cap = DEFAULT_AUDIT_CAP) {
    this.cap = cap;
    this.dir = join(dataDir, "computer-audit");
    this.slack = Math.max(1, Math.min(MAX_SLACK, Math.floor(cap / 10)));
  }

  private file(computerId: string): string {
    return join(this.dir, `${computerId.replace(SAFE_ID, "_").slice(0, 120) || "unknown"}.ndjson`);
  }

  append(row: ComputerAuditRow): void {
    try {
      const clean: ComputerAuditRow = {
        ts: row.ts, computerId: row.computerId, botId: row.botId, actor: row.actor,
        action: row.action.slice(0, 80), outcome: row.outcome,
        durationMs: Math.max(0, Math.round(row.durationMs)),
        ...(row.error ? { error: redactSecretsInText(row.error).replace(/\s+/g, " ").slice(0, MAX_ERROR_CHARS) } : {}),
      };
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const file = this.file(row.computerId);
      const fresh = !existsSync(file);
      appendFileSync(file, JSON.stringify(clean) + "\n", { mode: 0o600 });
      if (fresh) chmodSync(file, 0o600);
      const known = this.counts.get(file);
      const count = known === undefined ? this.readAll(file).length : known + 1;
      this.counts.set(file, count);
      if (count > this.cap + this.slack) this.trim(file);
    } catch { /* never block the action being audited */ }
  }

  /** Newest first. */
  list(computerId: string, query: AuditQuery = {}): ComputerAuditRow[] {
    const limit = Math.min(Math.max(query.limit ?? 200, 1), this.cap);
    const rows: ComputerAuditRow[] = [];
    const all = this.readAll(this.file(computerId)).slice(-this.cap);
    for (let i = all.length - 1; i >= 0 && rows.length < limit; i--) {
      const row = all[i]!;
      if (query.botId && row.botId !== query.botId) continue;
      if (query.action && row.action !== query.action) continue;
      if (query.outcome && row.outcome !== query.outcome) continue;
      rows.push(row);
    }
    return rows;
  }

  /** Rows retained for a computer: never more than the cap. */
  size(computerId: string): number {
    return Math.min(this.readAll(this.file(computerId)).length, this.cap);
  }

  private readAll(file: string): ComputerAuditRow[] {
    if (!existsSync(file)) return [];
    const rows: ComputerAuditRow[] = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      try { rows.push(JSON.parse(line) as ComputerAuditRow); } catch { /* torn line */ }
    }
    return rows;
  }

  private trim(file: string): void {
    const kept = this.readAll(file).slice(-this.cap);
    writeFileSync(file, kept.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
    this.counts.set(file, kept.length);
  }
}

// ── the dispatcher wrapper ─────────────────────────────────────────────

export interface AuditedCallDeps<R> {
  audit: ComputerAuditLog;
  epochs: ComputerEpochs;
  botId: string;
  computerId: string;
  actor?: AuditActor;
  /** Re-derives permission: a reason string when the call is no longer allowed. */
  check?: () => string | null;
  /** The underlying dispatch. `gate` and `assertActive` are the wrapped ones;
   * pass them through to the unwrapped RPC so held/revoked are observed. */
  dispatch(ctx: {
    signal: AbortSignal;
    gate<G extends { held: boolean }>(inner: () => Promise<G>): Promise<G>;
    assertActive(inner: () => void): void;
  }): Promise<R>;
  /** Called with the result to classify; defaults to `isError` => error. */
  failed?(result: R): boolean;
  /** The request's own cancellation (client hung up). */
  requestSignal?: AbortSignal;
  now?: () => number;
}

export type AuditedCallResult<R> =
  | { kind: "result"; result: R }
  | { kind: "revoked"; reason: string };

/** Run one computer tool call with an epoch lease and exactly one audit row. */
export async function auditedComputerCall<R>(tool: string, deps: AuditedCallDeps<R>): Promise<AuditedCallResult<R>> {
  const now = deps.now ?? Date.now;
  const started = now();
  const actor = deps.actor ?? "bot";
  const record = (outcome: AuditOutcome, error?: string) => deps.audit.append({
    ts: started, computerId: deps.computerId, botId: deps.botId, actor, action: tool,
    outcome, durationMs: now() - started, ...(error ? { error } : {}),
  });
  let lease;
  try { lease = deps.epochs.begin(deps.botId, deps.computerId, deps.check); }
  catch (error) {
    if (error instanceof ComputerRevokedError) { record("denied", error.reason); return { kind: "revoked", reason: error.reason }; }
    throw error;
  }
  const signal = deps.requestSignal ? AbortSignal.any([lease.signal, deps.requestSignal]) : lease.signal;
  let heldReason: string | null = null;
  try {
    const result = await deps.dispatch({
      signal,
      gate: async (inner) => {
        lease.assertCurrent();
        const state = await inner();
        if (state.held) heldReason = (state as { blockedReason?: string }).blockedReason ?? "the person has control of this computer";
        return state;
      },
      assertActive: (inner) => { inner(); lease.assertCurrent(); },
    });
    lease.assertCurrent();
    if (heldReason) record("denied", heldReason);
    else if (deps.failed ? deps.failed(result) : Boolean((result as { isError?: boolean } | undefined)?.isError)) record("error", "the tool reported a failure");
    else record("ok");
    return { kind: "result", result };
  } catch (error) {
    const reason = lease.revokedReason() ?? (error instanceof ComputerRevokedError ? error.reason : null);
    if (reason) { record("denied", `cancelled: ${reason}`); return { kind: "revoked", reason }; }
    record("error", error instanceof Error ? error.message : "computer call failed");
    throw error;
  } finally { lease.end(); }
}
