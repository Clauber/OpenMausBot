// Browsers a tool call or the live view has opened, and when each was last
// used. A turn only mounts browser tools, so a session appears here once it
// really starts a browser; closeIdle closes the ones nobody is using.
type Opened<Spec> = { spec: Spec; usedAt: number };

export class OpenedBrowsers<Spec> {
  private readonly sessions = new Map<string, Opened<Spec>>();
  private readonly idleMs: number;
  constructor(idleMs: number) { this.idleMs = idleMs; }

  use(session: string, spec: Spec, now = Date.now()): void { this.sessions.set(session, { spec, usedAt: now }); }

  spec(session: string): Spec | undefined { return this.sessions.get(session)?.spec; }

  forget(session: string): void { this.sessions.delete(session); }

  /** Close each session idle for idleMs that `inUse` does not claim. `close`
   * throws when it cannot close now; that session is retried next sweep. */
  async closeIdle(inUse: (session: string) => boolean, close: (session: string, spec: Spec) => Promise<void>, now = Date.now()): Promise<string[]> {
    const closed: string[] = [];
    for (const [session, opened] of this.sessions) {
      if (now - opened.usedAt < this.idleMs || inUse(session)) continue;
      try { await close(session, opened.spec); } catch { continue; }
      // A tool call during the close re-opened the session; keep that one.
      if (this.sessions.get(session) === opened) this.sessions.delete(session);
      closed.push(session);
    }
    return closed;
  }
}
