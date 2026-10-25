import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureZcodeDeviceId, parseZcodeServerReady, readZcodeRunningTaskCount, readZcodeServerStatus, startZcodeServer, type StartedZcodeServer } from "./process.ts";

// A stand-in for the official bundle: `bin/zcode` runs this script, which speaks `serve`, `stop` and `status` the way the
// real server does (ready line on stdout, token and status.json under the data dir, "already running" on stderr, exit on SIGTERM).
const FAKE_SERVER = String.raw`
const fs = require("fs"), path = require("path"), net = require("net"), cp = require("child_process");
const data = process.env.ZCODE_DATA_BASE_DIR;
const run = path.join(data, ".zcode", "server", "run");
const statusPath = path.join(run, "status.json");
const mode = process.env.FAKE_MODE || "";
const token = process.env.FAKE_TOKEN || "fake-token";
const readStatus = () => { try { return JSON.parse(fs.readFileSync(statusPath, "utf8")); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const command = process.argv[2];
if (command === "status") {
  let count = 0;
  try { count = Number(fs.readFileSync(path.join(data, "running-tasks"), "utf8")); } catch {}
  console.error("(node) ExperimentalWarning: SQLite is an experimental feature");
  console.log(JSON.stringify({ ...(readStatus() || { state: "stopped" }), runningTaskCount: count }));
} else if (command === "stop") {
  const status = readStatus();
  if (status && status.pid && alive(status.pid)) process.kill(status.pid, "SIGTERM");
  console.log('{"stopping":true}');
} else if (command === "serve") {
  const status = readStatus();
  if (status && status.state === "ready" && alive(status.pid)) { console.error("Another ZCode Server instance is already running"); process.exit(1); }
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(data, "server.pid"), String(process.pid));
  fs.writeFileSync(path.join(data, "env.json"), JSON.stringify({ cwd: process.cwd(), home: process.env.HOME, data: process.env.ZCODE_DATA_BASE_DIR, codium: process.env.ZCODIUM_DATA_BASE_DIR, command: process.env.ZCODE_AGENT_SERVER_COMMAND, args: process.env.ZCODE_AGENT_SERVER_ARGS_JSON, keep: process.env.FAKE_KEEP }));
  if (mode === "crash") { console.log(token); console.error(token); process.exit(3); }
  const stubborn = process.env.FAKE_CHILD === "stubborn";
  const child = cp.spawn(process.execPath, ["-e", (stubborn ? "process.on('SIGTERM',()=>{});" : "") + "setInterval(()=>{},1000)"], { stdio: "ignore" });
  fs.writeFileSync(path.join(data, "child.pid"), String(child.pid));
  process.on("SIGTERM", () => {
    if (!stubborn) child.kill();
    try { fs.writeFileSync(statusPath, JSON.stringify({ state: "stopped", pid: null })); } catch {}
    process.exit(0);
  });
  const server = net.createServer(() => {});
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    fs.writeFileSync(path.join(run, "ingress-token"), mode === "empty-token" ? "\n" : token + "\n", { mode: 0o600 });
    fs.writeFileSync(statusPath, JSON.stringify({ state: "ready", pid: process.pid, port, host: "127.0.0.1", version: "9.9.9-fake" }));
    if (mode !== "silent") console.log("ZCode Server ready at 127.0.0.1:" + port);
  });
}
`;

let dir: string;
let root: string;
let dataDir: string;
let botHomesRoot: string;
const started: StartedZcodeServer[] = [];

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pidFile = (name: string) => Number(readFileSync(join(dataDir, name), "utf8"));
async function waitUntil(condition: () => boolean) {
  for (let i = 0; i < 100 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  expect(condition()).toBe(true);
}
const start = async (env: Record<string, string> = {}, extra: { startupTimeoutMs?: number } = {}) => {
  const server = await startZcodeServer({ root, dataDir, botHomesRoot, env: { ...process.env, ...env }, ...extra });
  started.push(server);
  return server;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zcode-process-"));
  root = join(dir, "bundle");
  dataDir = join(dir, "data");
  botHomesRoot = join(dir, "homes");
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "fake-server.cjs"), FAKE_SERVER);
  writeFileSync(join(root, "bin", "zcode"), `#!/bin/sh\nexec "${process.execPath}" "${join(root, "fake-server.cjs")}" "$@"\n`, { mode: 0o755 });
});

afterEach(async () => {
  for (const server of started.splice(0)) await server.stop().catch(() => {});
  for (const name of ["server.pid", "child.pid"]) {
    try {
      const pid = pidFile(name);
      if (alive(pid)) process.kill(pid, "SIGKILL"); // only PIDs these tests spawned
    } catch {}
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("parseZcodeServerReady", () => {
  it("reads host and port from the ready line anywhere in the output", () => {
    expect(parseZcodeServerReady("[trace] x\nZCode Server ready at 127.0.0.1:41865\n")).toEqual({ host: "127.0.0.1", port: 41865 });
  });
  it("rejects a missing line and an out of range port", () => {
    expect(parseZcodeServerReady("starting")).toBeNull();
    expect(parseZcodeServerReady("ZCode Server ready at 127.0.0.1:0")).toBeNull();
    expect(parseZcodeServerReady("ZCode Server ready at 127.0.0.1:70000")).toBeNull();
  });
});

describe("ensureZcodeDeviceId", () => {
  it("creates a device ID once and keeps it", async () => {
    await ensureZcodeDeviceId(dataDir);
    const file = join(dataDir, ".zcode", "v2", "telemetry-state.json");
    const first = JSON.parse(readFileSync(file, "utf8")) as { deviceMid: string };
    expect(first.deviceMid).toMatch(/^[0-9a-f-]{36}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await ensureZcodeDeviceId(dataDir);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(first);
    expect(JSON.parse(readFileSync(join(dataDir, ".zcodium", "v2", "telemetry-state.json"), "utf8")).deviceMid).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("readZcodeServerStatus", () => {
  const write = (text: string) => {
    mkdirSync(join(dataDir, ".zcode", "server", "run"), { recursive: true });
    writeFileSync(join(dataDir, ".zcode", "server", "run", "status.json"), text);
  };
  it("returns null when absent or unreadable", async () => {
    expect(await readZcodeServerStatus(dataDir)).toBeNull();
    write("{nope");
    expect(await readZcodeServerStatus(dataDir)).toBeNull();
    write("[]");
    expect(await readZcodeServerStatus(dataDir)).toBeNull();
  });
  it("normalises the fields it knows", async () => {
    write(JSON.stringify({ state: "ready", pid: 12, port: 4000, host: "127.0.0.1", version: "3.16.2", extra: 1 }));
    expect(await readZcodeServerStatus(dataDir)).toEqual({ state: "ready", pid: 12, port: 4000, host: "127.0.0.1", version: "3.16.2" });
    write(JSON.stringify({ state: "stopped", pid: null, port: null, host: null }));
    expect(await readZcodeServerStatus(dataDir)).toEqual({ state: "stopped", pid: null, port: null, host: null, version: null });
  });
});

describe("startZcodeServer", () => {
  it("starts the server, reads the token and wires the data dir and agent wrapper into its environment", async () => {
    const server = await start({ HOME: "/real/home", FAKE_KEEP: "kept" });
    expect(server.adopted).toBe(false);
    expect(server.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/ws$/);
    expect(server.token).toBe("fake-token");
    const seen = JSON.parse(readFileSync(join(dataDir, "env.json"), "utf8"));
    expect(seen).toMatchObject({ cwd: dataDir, home: "/real/home", data: dataDir, codium: dataDir, keep: "kept", args: '["app-server","--stdio"]' });
    expect(seen.command).toBe(join(dataDir, "legion-agent.sh"));
    expect(statSync(seen.command).mode & 0o111).not.toBe(0);
    expect(JSON.parse(readFileSync(join(dataDir, ".zcode", "v2", "telemetry-state.json"), "utf8")).deviceMid).toBeTruthy();
  });

  it("stop reaps the whole process group, including a child that ignores SIGTERM", async () => {
    const server = await start({ FAKE_CHILD: "stubborn" });
    const serverPid = pidFile("server.pid");
    const childPid = pidFile("child.pid");
    expect(alive(serverPid) && alive(childPid)).toBe(true);
    await server.stop();
    await server.exited;
    await waitUntil(() => !alive(serverPid) && !alive(childPid));
  }, 20_000);

  it("adopts a server that is already running and stops it with `stop`", async () => {
    const owned = await start({ FAKE_TOKEN: "shared-token" });
    const adopted = await start({ FAKE_TOKEN: "shared-token" });
    expect(adopted.adopted).toBe(true);
    expect(adopted.url).toBe(owned.url);
    expect(adopted.token).toBe("shared-token");
    await adopted.stop();
    await owned.exited;
    await adopted.exited;
    expect(alive(pidFile("server.pid"))).toBe(false);
  });

  it("does not adopt a server whose status is not ready", async () => {
    const owned = await start();
    await owned.stop();
    await owned.exited;
    const second = await start();
    expect(second.adopted).toBe(false);
  });

  it("reports an early exit without leaking the token", async () => {
    const error = await start({ FAKE_MODE: "crash", FAKE_TOKEN: "super-secret-token" }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("ZCode server start failed: Server exited before it was ready (code 3).");
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain("super-secret-token");
  });

  it("times out when the ready line never comes and kills the process", async () => {
    const error = await start({ FAKE_MODE: "silent" }, { startupTimeoutMs: 400 }).catch((e: Error) => e);
    expect((error as Error).message).toBe("ZCode server start failed: Timed out.");
    await waitUntil(() => !alive(pidFile("server.pid")));
  });

  it("kills the server and fails when the ingress token is empty", async () => {
    const error = await start({ FAKE_MODE: "empty-token" }).catch((e: Error) => e);
    expect((error as Error).message).toBe("ZCode server token failed: Ingress token is empty.");
    await waitUntil(() => !alive(pidFile("server.pid")));
  });

  it("fails fast when the bundle has no bin/zcode", async () => {
    rmSync(join(root, "bin", "zcode"));
    await expect(start()).rejects.toThrow("ZCode server locate failed: Server path has no bin/zcode executable.");
  });
});

describe("readZcodeRunningTaskCount", () => {
  it("reads runningTaskCount from `bin/zcode status` despite warnings on stderr", async () => {
    await start();
    writeFileSync(join(dataDir, "running-tasks"), "3");
    expect(await readZcodeRunningTaskCount({ root, dataDir, env: process.env })).toBe(3);
  });
  it("is null when the command fails", async () => {
    expect(await readZcodeRunningTaskCount({ root: join(dir, "missing"), dataDir, env: process.env })).toBeNull();
  });
});

// Opt-in: ZCODE_SERVER_TEST_PATH is an official bundle root (it needs no login to start). Uses a fresh data dir.
describe.skipIf(!process.env.ZCODE_SERVER_TEST_PATH)("real ZCode server bundle", () => {
  it("starts, is adopted by a second start, answers `status` and stops", async () => {
    const realRoot = process.env.ZCODE_SERVER_TEST_PATH!;
    const args = { root: realRoot, dataDir, botHomesRoot, env: process.env };
    const server = await startZcodeServer(args);
    started.push(server);
    expect(server.adopted).toBe(false);
    expect(server.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/ws$/);
    expect(server.token.length).toBeGreaterThan(8);
    const status = await readZcodeServerStatus(dataDir);
    expect(status).toMatchObject({ state: "ready", host: "127.0.0.1" });
    expect(`ws://127.0.0.1:${status!.port}/ws`).toBe(server.url);
    expect(await readZcodeRunningTaskCount(args)).toBe(0);
    const adopted = await startZcodeServer(args);
    expect(adopted).toMatchObject({ adopted: true, url: server.url, token: server.token });
    await server.stop();
    await server.exited;
    expect((await readZcodeServerStatus(dataDir))?.state).not.toBe("ready");
  }, 90_000);
});
