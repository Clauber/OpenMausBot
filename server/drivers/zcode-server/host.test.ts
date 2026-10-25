import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZcodeServerHost } from "./host.ts";
import type { StartedZcodeServer } from "./process.ts";

interface FakeServer extends StartedZcodeServer {
  stops: number;
  die(): void;
}

let dir: string;
let dataDir: string;
let hosts: ZcodeServerHost[];
let servers: FakeServer[];
let starts: number;
let startGate: Promise<void>;
let stopGate: Promise<void>;
let failNextStart: boolean;

function fakeServer(): FakeServer {
  let die!: () => void;
  const exited = new Promise<void>((resolve) => (die = resolve));
  const server: FakeServer = {
    url: `ws://127.0.0.1:${4000 + servers.length}/ws`,
    token: "fake-token",
    adopted: false,
    exited,
    stops: 0,
    die,
    async stop() {
      server.stops += 1;
      await stopGate;
      die();
    },
  };
  servers.push(server);
  return server;
}

// `root` holds a `bin/zcode` that answers `status` the way the real one does, so the idle check runs the real command path.
function makeHost(idleMs = 20) {
  const host = new ZcodeServerHost({
    resolveRoot: async () => dir,
    dataDir,
    botHomesRoot: join(dir, "homes"),
    env: () => ({ ...process.env }),
    idleMs,
    start: async () => {
      starts += 1;
      await startGate;
      if (failNextStart) {
        failNextStart = false;
        throw new Error("boom");
      }
      return fakeServer();
    },
  });
  hosts.push(host);
  return host;
}

const setRunningTasks = (count: number) => writeFileSync(join(dataDir, "status-body.json"), JSON.stringify({ runningTaskCount: count }));
async function waitUntil(condition: () => boolean) {
  for (let i = 0; i < 100 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(condition()).toBe(true);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zcode-host-"));
  dataDir = join(dir, "data");
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(dataDir);
  writeFileSync(join(dir, "bin", "zcode"), '#!/bin/sh\ncat "$ZCODE_DATA_BASE_DIR/status-body.json"\n', { mode: 0o755 });
  setRunningTasks(0);
  hosts = [];
  servers = [];
  starts = 0;
  startGate = Promise.resolve();
  stopGate = Promise.resolve();
  failNextStart = false;
});

afterEach(async () => {
  for (const host of hosts) await host.stopAll();
  rmSync(dir, { recursive: true, force: true });
});

describe("ZcodeServerHost", () => {
  it("shares one start between concurrent acquires and hands out the endpoint", async () => {
    const host = makeHost();
    const leases = await Promise.all([host.acquire(), host.acquire(), host.acquire()]);
    expect(starts).toBe(1);
    expect(leases.map((lease) => lease.endpoint)).toEqual(Array(3).fill({ url: "ws://127.0.0.1:4000/ws", token: "fake-token" }));
  });

  it("reuses the running server for a later acquire", async () => {
    const host = makeHost(10_000);
    (await host.acquire()).release();
    await host.acquire();
    expect(starts).toBe(1);
  });

  it("stops the server after the last lease is released and the idle time passes", async () => {
    const host = makeHost();
    const a = await host.acquire();
    const b = await host.acquire();
    a.release();
    a.release(); // a second release of the same lease changes nothing
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(servers[0]!.stops).toBe(0);
    b.release();
    await waitUntil(() => servers[0]!.stops === 1);
  });

  it("cancels the idle stop when a lease is taken again", async () => {
    const host = makeHost(60);
    (await host.acquire()).release();
    const again = await host.acquire();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(servers[0]!.stops).toBe(0);
    expect(again.endpoint.url).toBe(servers[0]!.url);
  });

  it("keeps the server while it reports running tasks, then stops it", async () => {
    setRunningTasks(2);
    const host = makeHost();
    (await host.acquire()).release();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(servers[0]!.stops).toBe(0);
    setRunningTasks(0);
    await waitUntil(() => servers[0]!.stops === 1);
  });

  it("stops the server when the status command cannot be run", async () => {
    rmSync(join(dir, "bin", "zcode"));
    const host = makeHost();
    (await host.acquire()).release();
    await waitUntil(() => servers[0]!.stops === 1);
  });

  it("starts a fresh server after the running one dies", async () => {
    const host = makeHost(10_000);
    const first = await host.acquire();
    servers[0]!.die();
    await new Promise((resolve) => setImmediate(resolve));
    const second = await host.acquire();
    expect(starts).toBe(2);
    expect(second.endpoint.url).not.toBe(first.endpoint.url);
    first.release(); // a lease on a dead server is harmless
    expect(servers[1]!.stops).toBe(0);
  });

  it("surfaces a start failure to every waiter and retries on the next acquire", async () => {
    failNextStart = true;
    const host = makeHost();
    const results = await Promise.allSettled([host.acquire(), host.acquire()]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(starts).toBe(1);
    expect((await host.acquire()).endpoint.token).toBe("fake-token");
    expect(starts).toBe(2);
  });

  it("does not start a new server while the old one is still being stopped", async () => {
    let openStop!: () => void;
    stopGate = new Promise<void>((resolve) => (openStop = resolve));
    const host = makeHost();
    (await host.acquire()).release();
    await waitUntil(() => servers[0]!.stops === 1);
    const next = host.acquire();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(starts).toBe(1);
    openStop();
    await next;
    expect(starts).toBe(2);
  });

  it("stopAll stops the server and waits for an in-flight start", async () => {
    let openStart!: () => void;
    startGate = new Promise<void>((resolve) => (openStart = resolve));
    const host = makeHost();
    const acquiring = host.acquire();
    const stopping = host.stopAll();
    openStart();
    await acquiring;
    await stopping;
    expect(servers[0]!.stops).toBe(1);
  });
});
