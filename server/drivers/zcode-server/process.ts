// Starts, or adopts, the ZCode server (`bin/zcode serve`) for one data dir. The data dir holds the login, providers and
// sessions, so Legion's never touches the user's ~/.zcode; HOME stays real. `serve` prints `ZCode Server ready at <host>:<port>`
// once the core listens and writes the ingress token to `<data>/.zcode/server/run/ingress-token`. The token lives in memory
// only: it is never logged and never put in an error, and the server's stderr is drained without being kept.
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execCli, killCliTree, spawnCli } from "../../procs.ts";
import { writeAgentWrapper } from "./agent-wrapper.ts";

export class ZcodeServerError extends Error {
  operation: string;
  detail?: string;
  constructor(operation: string, detail?: string) {
    super(`ZCode server ${operation} failed${detail === undefined ? "" : `: ${detail}`}.`);
    this.name = "ZcodeServerError";
    this.operation = operation;
    this.detail = detail;
  }
}

export interface ZcodeServerEndpoint {
  url: string;
  token: string;
}

export interface StartedZcodeServer extends ZcodeServerEndpoint {
  /** True when a server we did not spawn in this process was already running. */
  adopted: boolean;
  /** Owned: SIGTERM the process group, then SIGKILL. Adopted: `bin/zcode stop`. Resolves once the server is gone. */
  stop(): Promise<void>;
  readonly exited: Promise<void>;
}

const STARTUP_TIMEOUT_MS = 30_000;
const STARTUP_OUTPUT_MAX_CHARS = 8_192;
const TERMINATION_GRACE_MS = 2_000;
const ADOPT_READY_WAIT_MS = 10_000;
const ADOPTED_STOP_WAIT_MS = 10_000;
const CLI_TIMEOUT_MS = 10_000;
const READY_PATTERN = /ZCode Server ready at (\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})/;
const ALREADY_RUNNING = "Another ZCode Server instance is already running";

export function parseZcodeServerReady(output: string): { host: string; port: number } | null {
  const match = READY_PATTERN.exec(output);
  if (match === null) return null;
  const port = Number(match[2]);
  return port > 0 && port < 65_536 ? { host: match[1]!, port } : null;
}

/** The ZCodium fork reads the `ZCODIUM_` spelling of the same variables and keeps its files under `.zcodium/v2`, so both are set. */
export function zcodeServerEnvironment(env: NodeJS.ProcessEnv, dataDir: string, agentCommand?: string): NodeJS.ProcessEnv {
  return {
    ...env,
    ZCODE_DATA_BASE_DIR: dataDir,
    ZCODIUM_DATA_BASE_DIR: dataDir,
    ...(agentCommand === undefined ? {} : { ZCODE_AGENT_SERVER_COMMAND: agentCommand, ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify(["app-server", "--stdio"]) }),
  };
}

const runDir = (dataDir: string) => join(dataDir, ".zcode", "server", "run");

/** Start Plan bills against a per-install device ID that ZCode's desktop app writes at launch and `serve` does not, so a fresh one is
 * created when none exists. It is never copied from another install, and an existing one is kept. */
export async function ensureZcodeDeviceId(dataDir: string): Promise<void> {
  for (const folder of [".zcode", ".zcodium"]) {
    const directory = join(dataDir, folder, "v2");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "telemetry-state.json"), JSON.stringify({ deviceMid: randomUUID() }), { flag: "wx", mode: 0o600 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
}

export async function readZcodeServerStatus(dataDir: string): Promise<{ state: string; pid: number | null; host: string | null; port: number | null; version: string | null } | null> {
  try {
    const raw = JSON.parse(await readFile(join(runDir(dataDir), "status.json"), "utf8")) as Record<string, unknown> | null;
    if (raw === null || typeof raw !== "object" || typeof raw.state !== "string") return null;
    const int = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null);
    const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
    return { state: raw.state, pid: int(raw.pid), host: text(raw.host), port: int(raw.port), version: text(raw.version) };
  } catch {
    return null;
  }
}

/** `runningTaskCount` from `bin/zcode status`, or null when the server does not report it or cannot be asked. */
export async function readZcodeRunningTaskCount(options: { root: string; dataDir: string; env: NodeJS.ProcessEnv }): Promise<number | null> {
  try {
    const stdout = await runZcode(options, "status");
    const count = (JSON.parse(stdout.slice(stdout.indexOf("{"))) as { runningTaskCount?: unknown }).runningTaskCount;
    return typeof count === "number" && Number.isFinite(count) ? count : null;
  } catch {
    return null;
  }
}

function runZcode(options: { root: string; dataDir: string; env: NodeJS.ProcessEnv }, command: "status" | "stop"): Promise<string> {
  return new Promise((resolve, reject) => {
    execCli(join(options.root, "bin", "zcode"), [command], { cwd: options.dataDir, env: zcodeServerEnvironment(options.env, options.dataDir), timeout: CLI_TIMEOUT_MS }, (error, stdout) => {
      if (error) reject(new ZcodeServerError(command));
      else resolve(stdout);
    });
  });
}

async function readIngressToken(dataDir: string): Promise<string> {
  let value: string;
  try {
    value = (await readFile(join(runDir(dataDir), "ingress-token"), "utf8")).trim();
  } catch {
    throw new ZcodeServerError("token", "Ingress token is unreadable");
  }
  if (value === "") throw new ZcodeServerError("token", "Ingress token is empty");
  return value;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

const isLoopback = (host: string) => host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
const wsUrl = (host: string, port: number) => `ws://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}/ws`;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function adoptRunningServer(options: { root: string; dataDir: string; env: NodeJS.ProcessEnv }): Promise<StartedZcodeServer> {
  // The other instance may still be booting; wait for it rather than fail a start that would have worked a moment later.
  const deadline = Date.now() + ADOPT_READY_WAIT_MS;
  let status = await readZcodeServerStatus(options.dataDir);
  while ((status === null || status.state === "starting") && Date.now() < deadline) {
    await delay(200);
    status = await readZcodeServerStatus(options.dataDir);
  }
  if (status === null || status.state !== "ready" || status.pid === null || status.port === null || status.host === null || !isLoopback(status.host)) {
    throw new ZcodeServerError("adopt", "The running server is not ready on a loopback address");
  }
  const { pid, host, port } = status;
  const token = await readIngressToken(options.dataDir);
  // `pid` is the server core, which the supervisor restarts on a crash; a core that is gone means this endpoint is gone.
  const exited = new Promise<void>((resolve) => {
    if (!pidAlive(pid)) return resolve();
    const timer = setInterval(() => {
      if (pidAlive(pid)) return;
      clearInterval(timer);
      resolve();
    }, 500);
    timer.unref();
  });
  return {
    url: wsUrl(host, port),
    token,
    adopted: true,
    exited,
    async stop() {
      await runZcode(options, "stop").catch(() => {});
      await Promise.race([exited, delay(ADOPTED_STOP_WAIT_MS)]);
    },
  };
}

type StartOutcome = { kind: "ready"; host: string; port: number } | { kind: "already-running" } | { kind: "exit"; code: number | null } | { kind: "spawn" } | { kind: "timeout" };

export async function startZcodeServer(options: { root: string; dataDir: string; botHomesRoot: string; env: NodeJS.ProcessEnv; startupTimeoutMs?: number }): Promise<StartedZcodeServer> {
  const executable = join(options.root, "bin", "zcode");
  if (!(await access(executable).then(() => true, () => false))) throw new ZcodeServerError("locate", "Server path has no bin/zcode executable");
  let agentCommand: string;
  try {
    await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
    await ensureZcodeDeviceId(options.dataDir);
    agentCommand = await writeAgentWrapper(options);
  } catch {
    throw new ZcodeServerError("prepare");
  }

  // spawnCli puts the supervisor in its own process group, so killCliTree reaps the supervisor, the core and the agents.
  const child = spawnCli(executable, ["serve"], { cwd: options.dataDir, env: zcodeServerEnvironment(options.env, options.dataDir, agentCommand), stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });

  const outcome = await new Promise<StartOutcome>((resolve) => {
    let output = "";
    let stderrTail = "";
    let settled = false;
    const settle = (value: StartOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => settle({ kind: "timeout" }), options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (settled) return;
      output = `${output}${chunk}`.slice(-STARTUP_OUTPUT_MAX_CHARS);
      const ready = parseZcodeServerReady(output);
      if (ready) settle({ kind: "ready", ...ready });
    });
    // stderr is drained; only a window as wide as the marker is looked at, to recognise a second `serve`.
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (settled) return;
      stderrTail = `${stderrTail}${chunk}`.slice(-ALREADY_RUNNING.length * 2);
    });
    child.once("error", () => settle({ kind: "spawn" }));
    child.once("close", (code) => settle(stderrTail.includes(ALREADY_RUNNING) || output.includes(ALREADY_RUNNING) ? { kind: "already-running" } : { kind: "exit", code }));
  });

  if (outcome.kind === "already-running") return adoptRunningServer(options);
  if (outcome.kind !== "ready") {
    if (outcome.kind === "timeout") await killCliTree(child, TERMINATION_GRACE_MS);
    if (outcome.kind === "spawn") throw new ZcodeServerError("spawn");
    throw new ZcodeServerError("start", outcome.kind === "timeout" ? "Timed out" : `Server exited before it was ready (code ${outcome.code})`);
  }

  let token: string;
  try {
    token = await readIngressToken(options.dataDir);
  } catch (error) {
    await killCliTree(child, TERMINATION_GRACE_MS);
    throw error;
  }
  return {
    url: wsUrl(outcome.host, outcome.port),
    token,
    adopted: false,
    exited,
    async stop() {
      await killCliTree(child, TERMINATION_GRACE_MS);
      await exited;
    },
  };
}
