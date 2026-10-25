// Owns the one lazily started ZCode server that every bot on this Legion shares. The first acquire starts (or adopts) it,
// the last release arms an idle timer, and a server that exits is dropped so the next acquire starts a fresh one.
import { readZcodeRunningTaskCount, startZcodeServer, type StartedZcodeServer, type ZcodeServerEndpoint } from "./process.ts";

export interface ZcodeServerLease {
  endpoint: ZcodeServerEndpoint;
  release(): void;
}

const DEFAULT_IDLE_MS = 120_000;

interface Entry {
  root: string;
  server: StartedZcodeServer;
  leases: number;
  dead: boolean;
  idleTimer: NodeJS.Timeout | null;
}

export class ZcodeServerHost {
  #options: { resolveRoot: () => Promise<string>; dataDir: string; botHomesRoot: string; env: () => NodeJS.ProcessEnv; idleMs?: number; start?: typeof startZcodeServer };
  #entry: Entry | null = null;
  #starting: Promise<Entry> | null = null;
  // A start that overlaps a stop would see the dying server as "already running" and adopt it.
  #stopping: Promise<void> = Promise.resolve();

  constructor(options: { resolveRoot: () => Promise<string>; dataDir: string; botHomesRoot: string; env: () => NodeJS.ProcessEnv; idleMs?: number; start?: typeof startZcodeServer }) {
    this.#options = options;
  }

  async acquire(): Promise<ZcodeServerLease> {
    for (;;) {
      const entry = this.#entry ?? (await (this.#starting ??= this.#startEntry().finally(() => { this.#starting = null })));
      if (entry.dead) continue;
      this.#clearIdle(entry);
      entry.leases += 1;
      let released = false;
      return {
        endpoint: { url: entry.server.url, token: entry.server.token },
        release: () => {
          if (released) return;
          released = true;
          entry.leases -= 1;
          if (entry.leases === 0 && !entry.dead) this.#armIdle(entry);
        },
      };
    }
  }

  async stopAll(): Promise<void> {
    await this.#starting?.catch(() => {});
    const entry = this.#entry;
    if (entry) await this.#close(entry);
    await this.#stopping;
  }

  async #startEntry(): Promise<Entry> {
    await this.#stopping;
    const root = await this.#options.resolveRoot();
    const server = await (this.#options.start ?? startZcodeServer)({ root, dataDir: this.#options.dataDir, botHomesRoot: this.#options.botHomesRoot, env: this.#options.env() });
    const entry: Entry = { root, server, leases: 0, dead: false, idleTimer: null };
    this.#entry = entry;
    void server.exited.then(() => {
      entry.dead = true;
      this.#clearIdle(entry);
      if (this.#entry === entry) this.#entry = null;
    });
    return entry;
  }

  #clearIdle(entry: Entry): void {
    clearTimeout(entry.idleTimer ?? undefined);
    entry.idleTimer = null;
  }

  #armIdle(entry: Entry): void {
    this.#clearIdle(entry);
    entry.idleTimer = setTimeout(() => void this.#idleClose(entry), this.#options.idleMs ?? DEFAULT_IDLE_MS);
    entry.idleTimer.unref();
  }

  async #idleClose(entry: Entry): Promise<void> {
    entry.idleTimer = null;
    // A session can keep running after its lease is gone (a background task); the server stays up while one does.
    const running = await readZcodeRunningTaskCount({ root: entry.root, dataDir: this.#options.dataDir, env: this.#options.env() });
    if (entry.dead || entry.leases > 0 || this.#entry !== entry) return;
    if (running !== null && running > 0) return this.#armIdle(entry);
    await this.#close(entry);
  }

  #close(entry: Entry): Promise<void> {
    this.#clearIdle(entry);
    if (this.#entry === entry) this.#entry = null;
    entry.dead = true;
    const stop = this.#stopping.then(() => entry.server.stop()).catch(() => {});
    this.#stopping = stop;
    return stop;
  }
}
