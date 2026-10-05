// Instant revocation for computer actions. Every in-flight computer call holds
// a lease on its bot-computer binding. A lease carries an AbortController and
// an optional `check` that re-derives whether the call is still permitted
// (owner disabled the computer, space isolation, approval downgraded to Ask).
// `revoke` and `revalidate` bump the binding's epoch and abort the matching
// leases synchronously, so a fetch or command on the lease's signal stops in
// well under 100ms instead of waiting for the call to finish. The dispatcher
// also checks the epoch before dispatch and after every await, so a call that
// slips between two checks still cannot report a result for a revoked binding.

export class ComputerRevokedError extends Error {
  readonly code = "computer_revoked";
  readonly reason: string;
  constructor(reason: string) {
    super(`Access to this computer was revoked: ${reason}`);
    this.reason = reason;
    this.name = "ComputerRevokedError";
  }
}

export interface ComputerLease {
  readonly botId: string;
  readonly computerId: string;
  readonly epoch: number;
  readonly signal: AbortSignal;
  /** The revocation reason once revoked, else null. */
  revokedReason(): string | null;
  /** Throws ComputerRevokedError when the binding was revoked since `begin`. */
  assertCurrent(): void;
  /** Release the lease; call exactly once when the action settles. */
  end(): void;
}

interface LeaseRecord {
  botId: string;
  computerId: string;
  epoch: number;
  controller: AbortController;
  check?: () => string | null;
  reason: string | null;
}

export class ComputerEpochs {
  private epochs = new Map<string, number>();
  private leases = new Set<LeaseRecord>();
  private key = (botId: string, computerId: string) => `${botId}\u0000${computerId}`;

  epoch(botId: string, computerId: string): number {
    return this.epochs.get(this.key(botId, computerId)) ?? 0;
  }

  inFlight(botId?: string): number {
    let count = 0;
    for (const lease of this.leases) if (!botId || lease.botId === botId) count++;
    return count;
  }

  /** Start an action. Throws ComputerRevokedError if `check` already refuses,
   * so the "before dispatch" check and the lease share one decision. */
  begin(botId: string, computerId: string, check?: () => string | null): ComputerLease {
    const refusal = check?.() ?? null;
    if (refusal) throw new ComputerRevokedError(refusal);
    const record: LeaseRecord = {
      botId, computerId, epoch: this.epoch(botId, computerId),
      controller: new AbortController(), ...(check ? { check } : {}), reason: null,
    };
    this.leases.add(record);
    return {
      botId, computerId, epoch: record.epoch, signal: record.controller.signal,
      revokedReason: () => record.reason ?? (this.epoch(botId, computerId) !== record.epoch ? "access was revoked" : null),
      assertCurrent: () => {
        const reason = record.reason ?? (this.epoch(botId, computerId) !== record.epoch ? "access was revoked" : null);
        if (reason) throw new ComputerRevokedError(reason);
      },
      end: () => { this.leases.delete(record); },
    };
  }

  /** Revoke a bot's access (to one computer, or all of them). Returns how many
   * in-flight actions were cancelled. */
  revoke(botId: string, reason: string, computerId?: string): number {
    const touched = new Set<string>();
    let cancelled = 0;
    for (const lease of [...this.leases]) {
      if (lease.botId !== botId || (computerId && lease.computerId !== computerId)) continue;
      touched.add(lease.computerId);
      cancelled += this.cancel(lease, reason);
    }
    if (computerId) touched.add(computerId);
    for (const id of touched) this.epochs.set(this.key(botId, id), this.epoch(botId, id) + 1);
    return cancelled;
  }

  /** Re-derive permission for in-flight actions and revoke those whose check
   * now refuses. Cheap: runs on every bot or space change. */
  revalidate(botId?: string): number {
    let cancelled = 0;
    for (const lease of [...this.leases]) {
      if (botId && lease.botId !== botId) continue;
      const reason = lease.check?.() ?? null;
      if (!reason) continue;
      cancelled += this.cancel(lease, reason);
      this.epochs.set(this.key(lease.botId, lease.computerId), this.epoch(lease.botId, lease.computerId) + 1);
    }
    return cancelled;
  }

  private cancel(lease: LeaseRecord, reason: string): number {
    if (lease.reason) return 0;
    lease.reason = reason;
    lease.controller.abort(new ComputerRevokedError(reason));
    return 1;
  }
}
