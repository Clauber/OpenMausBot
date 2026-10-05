import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, rmSync, statSync } from "node:fs";
import { copyFile, mkdtemp, readFile, stat, open, rm } from "node:fs/promises";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendDecision, flushDecisionLog } from "./decision-log.ts";
import { SERVER_ROOT } from "./proxy-paths.ts";
import type { AppConfig } from "./config.ts";
import type { UpdatePlan, UpdateResult, UpdaterState } from "../shared/updater.ts";

const execute = promisify(execFile);
const MAX_ARTIFACT = 200 * 1024 * 1024;
type Settings = NonNullable<AppConfig["updater"]>;
type Release = { version: string; url: string; sha256: string; channel?: string; changelog?: string };
interface Stored {
  lastCheck?: { at: string; plan?: UpdatePlan; error?: string };
  lastApply?: UpdateResult;
  registryUrl?: string;
  artifact?: string;
}
export interface UpdateJob {
  appDir: string;
  dataDir: string;
  lock: string;
  workDir: string;
  artifact: string;
  unit: string;
  port: number;
  plan: UpdatePlan & { target: string; sha256: string };
  runningTurns: number;
  healthTimeoutMs: number;
}
export interface UpdaterOptions {
  config(): Settings | undefined;
  dataDir: string;
  port: number;
  version: string;
  runningTurns?(): number;
  /** Explicit paths are for isolated fixtures; production discovers its app ancestor. */
  appDir?: string;
  workerPath?: string;
  commandEnv?: NodeJS.ProcessEnv;
  docker?: boolean;
  healthTimeoutMs?: number;
}

export class UpdaterError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) { super(message); this.status = status; }
}

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf8")) as T;
}
function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const staged = `${file}.${randomUUID()}.tmp`;
  writeFileSync(staged, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(staged, file);
}
const stateFile = (dataDir: string) => join(dataDir, "updater", "state.json");

export async function updateAudit(dataDir: string, summary: string): Promise<void> {
  appendDecision(dataDir, { threadId: "software-update", tool: "self-update", decision: "update", source: "updater", actor: { kind: "loopback" }, summary });
  await flushDecisionLog(dataDir);
}

/** SemVer ordering including prereleases; build metadata never makes a release newer. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v);
    if (!m) throw new UpdaterError(`Invalid version: ${v}`, 502);
    const pre = m[4]?.split(".");
    if (pre?.some(p => /^\d+$/.test(p) && p.length > 1 && p[0] === "0")) throw new UpdaterError(`Invalid version: ${v}`, 502);
    return { core: m.slice(1, 4).map(BigInt), pre };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! > y.core[i]! ? 1 : -1;
  if (!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === q) continue;
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return BigInt(p) > BigInt(q) ? 1 : -1;
    if (pn !== qn) return pn ? -1 : 1;
    return p > q ? 1 : -1;
  }
  return 0;
}

function registryIndex(location: string): URL {
  if (/^https?:\/\//.test(location)) {
    const url = new URL(location);
    if (url.username || url.password) throw new UpdaterError("Registry credentials in URLs are not supported", 400);
    if (url.pathname.endsWith("/")) url.pathname += "index.json";
    return url;
  }
  if (location.startsWith("file:")) return new URL(location.endsWith("/") ? location + "index.json" : location);
  if (!isAbsolute(location)) throw new UpdaterError("Registry must be an HTTP(S) URL or absolute directory/index path", 400);
  const path = existsSync(location) && statSync(location).isDirectory() ? join(location, "index.json") : location;
  return pathToFileURL(path);
}
async function bytes(url: URL, max: number): Promise<Buffer> {
  if (url.protocol === "file:") {
    if ((await stat(fileURLToPath(url))).size > max) throw new UpdaterError("Registry content is too large", 502);
    return readFile(fileURLToPath(url));
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UpdaterError("Unsupported registry URL", 400);
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: "error" });
  if (!response.ok || !response.body) throw new UpdaterError(`Registry HTTP ${response.status}`, 502);
  const chunks: Buffer[] = []; let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > max) throw new UpdaterError("Registry content is too large", 502);
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) { await response.body.cancel().catch(() => {}); throw error; }
  return Buffer.concat(chunks);
}

export async function verifyArtifact(file: string, sha256: string): Promise<number> {
  const handle = await open(file, "r");
  const hash = createHash("sha256"); let size = 0;
  try {
    for await (const chunk of handle.createReadStream()) {
      size += chunk.length;
      if (size > MAX_ARTIFACT) throw new UpdaterError("Artifact is too large", 502);
      hash.update(chunk);
    }
  } finally { await handle.close(); }
  if (hash.digest("hex") !== sha256) throw new UpdaterError("SHA-256 mismatch; installation was not changed", 422);
  return size;
}

function discoverAppDir(): string | undefined {
  let path = SERVER_ROOT;
  for (;;) {
    const pkg = readJson<{ dependencies?: Record<string, string> }>(join(path, "package.json"), {});
    if (pkg.dependencies?.openmausbot?.startsWith("file:vendor/") && existsSync(join(path, "vendor"))) return path;
    if (dirname(path) === path) return undefined;
    path = dirname(path);
  }
}

export class SelfUpdater {
  private readonly appDir: string | undefined;
  private readonly lock: string;
  private checking: Promise<UpdatePlan | { enabled: false }> | undefined;
  private readonly options: UpdaterOptions;
  constructor(options: UpdaterOptions) {
    this.options = options;
    this.appDir = options.appDir ?? discoverAppDir();
    this.lock = join(this.appDir ?? join(options.dataDir, "updater"), ".apply-lock");
  }
  private enabled(): Settings | undefined {
    const cfg = this.options.config();
    return cfg?.enabled && cfg.registryUrl ? cfg : undefined;
  }
  private stored(): Stored { return readJson(stateFile(this.options.dataDir), {}); }
  private layout(): "npm-package" | "checkout" | "docker" {
    if (this.options.docker ?? (existsSync("/.dockerenv") || process.env.container === "docker")) return "docker";
    return this.appDir ? "npm-package" : "checkout";
  }
  private current(): string {
    if (!this.appDir) return this.options.version;
    const fallback = existsSync(this.lock) ? this.stored().lastApply?.current ?? this.options.version : this.options.version;
    try {
      const version = readJson<{ version?: string }>(join(this.appDir, "node_modules", "openmausbot", "package.json"), {}).version;
      if (!version) throw new Error("Installed package version is unavailable");
      return version;
    } catch (error) {
      // npm replaces files non-atomically. The lock brackets that interval;
      // state polling must not fail on a missing or partially written manifest.
      if (existsSync(this.lock)) return fallback;
      throw error;
    }
  }
  state(): UpdaterState {
    const cfg = this.enabled();
    if (!cfg) return { enabled: false };
    const saved = this.stored();
    return { enabled: true, current: this.current(), layout: this.layout(), channel: cfg.channel ?? "stable", busy: existsSync(this.lock), runningTurns: this.options.runningTurns?.() ?? 0, lastCheck: saved.lastCheck, lastApply: saved.lastApply };
  }
  async plan(): Promise<UpdatePlan | { enabled: false }> {
    if (!this.enabled()) return { enabled: false };
    if (existsSync(this.lock)) throw new UpdaterError("An update is already running");
    if (this.checking) return this.checking;
    this.checking = this.check();
    try { return await this.checking; } finally { this.checking = undefined; }
  }
  private async check(): Promise<UpdatePlan> {
    const cfg = this.enabled()!;
    const at = new Date().toISOString(), current = this.current(), channel = cfg.channel ?? "stable";
    try {
      const index = registryIndex(cfg.registryUrl!);
      const raw: unknown = JSON.parse((await bytes(index, 1024 * 1024)).toString("utf8"));
      const releases = Array.isArray(raw) ? raw : (raw as { releases?: unknown } | null)?.releases;
      if (!Array.isArray(releases)) throw new UpdaterError("Registry index must contain releases", 502);
      const candidates: Release[] = releases.map((row: unknown) => {
        const r = row as Release;
        if (!r || typeof r.version !== "string" || typeof r.url !== "string" || !/^[a-f0-9]{64}$/i.test(r.sha256) || (r.channel !== undefined && typeof r.channel !== "string") || (r.changelog !== undefined && typeof r.changelog !== "string")) throw new UpdaterError("Invalid registry release", 502);
        compareVersions(r.version, r.version);
        return { ...r, sha256: r.sha256.toLowerCase() };
      }).filter(r => (r.channel ?? "stable") === channel && (channel !== "stable" || !r.version.split("+")[0]!.includes("-")) && compareVersions(r.version, current) > 0);
      candidates.sort((a, b) => compareVersions(b.version, a.version));
      const target = candidates[0];
      const plan: UpdatePlan = { enabled: true, current, target: target?.version ?? null, size: 0, channel };
      let artifact: string | undefined;
      if (target) {
        const url = new URL(target.url, index);
        if (!url.pathname.endsWith(".tgz")) throw new UpdaterError("Release artifact must be a tgz", 502);
        if (index.protocol !== "file:" && url.protocol === "file:") throw new UpdaterError("HTTP registry cannot read local files", 502);
        artifact = join(this.options.dataDir, "updater", "cache", `${target.sha256}.tgz`);
        mkdirSync(dirname(artifact), { recursive: true, mode: 0o700 });
        if (!existsSync(artifact)) {
          const content = await bytes(url, MAX_ARTIFACT);
          if (createHash("sha256").update(content).digest("hex") !== target.sha256) throw new UpdaterError("SHA-256 mismatch; installation was not changed", 422);
          writeFileSync(artifact, content, { mode: 0o600, flag: "wx" });
        }
        plan.size = await verifyArtifact(artifact, target.sha256);
        plan.sha256 = target.sha256;
        // CHANGELOG text is supplied explicitly by the private index; never rendered as HTML.
        if (target.changelog) plan.changes = target.changelog.slice(0, 64 * 1024);
      }
      writeJson(stateFile(this.options.dataDir), { ...this.stored(), lastCheck: { at, plan }, registryUrl: cfg.registryUrl, artifact });
      await updateAudit(this.options.dataDir, `plan ${current} -> ${plan.target ?? "up-to-date"}; channel=${channel}; sha256=${plan.sha256 ?? "none"}; size=${plan.size}`);
      return plan;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeJson(stateFile(this.options.dataDir), { ...this.stored(), lastCheck: { at, error: message } });
      await updateAudit(this.options.dataDir, `plan refused: ${message}`);
      throw error;
    }
  }
  async apply(expected?: { target?: string; sha256?: string }): Promise<UpdaterState> {
    try { return await this.startApply(expected); }
    catch (error) {
      await updateAudit(this.options.dataDir, `apply request refused: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
  private async startApply(expected?: { target?: string; sha256?: string }): Promise<UpdaterState> {
    const cfg = this.enabled();
    if (!cfg) return { enabled: false };
    if (this.checking || existsSync(this.lock)) throw new UpdaterError("An update/check is already running");
    const saved = this.stored(), plan = saved.lastCheck?.plan;
    if (!plan?.target || !plan.sha256 || !saved.artifact || saved.registryUrl !== cfg.registryUrl || plan.channel !== (cfg.channel ?? "stable") || plan.current !== this.current()) throw new UpdaterError("Check for updates again before applying");
    if ((expected?.target && expected.target !== plan.target) || (expected?.sha256 && expected.sha256 !== plan.sha256)) throw new UpdaterError("The reviewed plan changed; check again");
    const result: UpdateResult = { at: new Date().toISOString(), status: "starting", current: plan.current, target: plan.target, runningTurns: this.options.runningTurns?.() ?? 0 };
    if (this.layout() !== "npm-package" || !cfg.unit || process.platform !== "linux") {
      result.status = "manual";
      result.message = "Automatic apply requires an npm-package layout and a configured Linux systemd user unit. Update and restart this installation manually.";
      writeJson(stateFile(this.options.dataDir), { ...saved, lastApply: result });
      await updateAudit(this.options.dataDir, `apply no-op: ${result.message}`);
      return this.state();
    }
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]{0,127}$/.test(cfg.unit)) throw new UpdaterError("Invalid service unit", 400);
    mkdirSync(dirname(this.lock), { recursive: true, mode: 0o700 });
    try { mkdirSync(this.lock, { mode: 0o700 }); } catch { throw new UpdaterError("An update is already running"); }
    let workDir: string | undefined;
    let launchAttempted = false;
    try {
      await verifyArtifact(saved.artifact, plan.sha256);
      await execute("systemctl", ["--user", "show", cfg.unit, "--property=LoadState", "--value"], { timeout: 5000, env: this.options.commandEnv }).then(({ stdout }) => {
        if (stdout.trim() !== "loaded") throw new UpdaterError("Configured systemd user unit is not loaded");
      });
      const worker = this.options.workerPath ?? join(SERVER_ROOT, "updater.worker.js");
      if (!existsSync(worker)) throw new UpdaterError("The packaged updater worker is missing; build the server first");
      workDir = await mkdtemp(join(tmpdir(), "legion-update-"));
      await copyFile(worker, join(workDir, "worker.mjs"));
      await copyFile(saved.artifact, join(workDir, "release.tgz"));
      const job: UpdateJob = { appDir: this.appDir!, dataDir: this.options.dataDir, lock: this.lock, workDir, artifact: join(workDir, "release.tgz"), unit: cfg.unit, port: this.options.port, plan: plan as UpdateJob["plan"], runningTurns: result.runningTurns, healthTimeoutMs: this.options.healthTimeoutMs ?? 15_000 };
      writeJson(join(workDir, "job.json"), job);
      writeJson(join(this.lock, "job.json"), { workDir, unit: cfg.unit, at: result.at });
      writeJson(stateFile(this.options.dataDir), { ...saved, lastApply: result });
      await updateAudit(this.options.dataDir, `apply accepted ${plan.current} -> ${plan.target}; sha256=${plan.sha256}; runningTurns=${result.runningTurns} (allowed; restart interrupts active turns)`);
      // A detached child alone still belongs to the old service cgroup. A transient
      // user unit keeps the copied worker alive through the target unit's restart.
      launchAttempted = true;
      await execute("systemd-run", ["--user", "--collect", `--unit=legion-update-${randomUUID()}`, "--property=Type=exec", `--setenv=PATH=${this.options.commandEnv?.PATH ?? process.env.PATH ?? "/usr/bin:/bin"}`, `--setenv=TMPDIR=${workDir}`, process.execPath, join(workDir, "worker.mjs"), join(workDir, "job.json")], { timeout: 10_000, env: this.options.commandEnv });
      return this.state();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (launchAttempted) {
        // A bus timeout may happen after the transient unit started. Never remove
        // its lock or artifacts, or overwrite progress written by a live worker.
        await updateAudit(this.options.dataDir, `apply launch uncertain; lock retained for recovery: ${message}`);
      } else {
        result.status = "failed"; result.message = message;
        writeJson(stateFile(this.options.dataDir), { ...saved, lastApply: result });
        await updateAudit(this.options.dataDir, `apply refused before swap: ${message}`);
        rmSync(this.lock, { recursive: true, force: true });
        if (workDir) await rm(workDir, { recursive: true, force: true });
      }
      throw error;
    }
  }
}

export async function runUpdateJob(job: UpdateJob): Promise<void> {
  const pkgPath = join(job.appDir, "package.json"), lockPath = join(job.appDir, "package-lock.json");
  const original = readFileSync(pkgPath, "utf8");
  const oldLock = existsSync(lockPath) ? readFileSync(lockPath) : undefined;
  const previous = JSON.parse(original) as { dependencies?: Record<string, string> };
  const priorRef = previous.dependencies?.openmausbot;
  let swapped = false;
  const result: UpdateResult = { at: new Date().toISOString(), status: "starting", current: job.plan.current, target: job.plan.target, runningTurns: job.runningTurns };
  const progress = async (status: UpdateResult["status"], message?: string) => {
    result.status = status; result.message = message;
    writeJson(stateFile(job.dataDir), { ...readJson<Stored>(stateFile(job.dataDir), {}), lastApply: result });
    await updateAudit(job.dataDir, `${status} ${job.plan.current} -> ${job.plan.target}${message ? `: ${message}` : ""}`);
  };
  const install = async () => {
    // Bundled releases need no registry resolution or lifecycle scripts. Keep npm's
    // cache/logs private to this job; never fall through to the public npm registry.
    const emptyConfig = join(job.workDir, "npmrc");
    writeFileSync(emptyConfig, "");
    const globalConfig = join(job.workDir, "npm-globalrc");
    writeFileSync(globalConfig, "");
    await execute(process.platform === "win32" ? "npm.cmd" : "npm", ["--userconfig", emptyConfig, "--globalconfig", globalConfig, "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", join(job.workDir, "npm-cache")], { cwd: job.appDir, timeout: 120_000, maxBuffer: 1024 * 1024 });
  };
  const restart = async () => { await execute("systemctl", ["--user", "restart", job.unit], { timeout: 30_000 }); };
  const health = async (version: string) => {
    const end = Date.now() + job.healthTimeoutMs;
    do {
      try {
        const response = await fetch(`http://127.0.0.1:${job.port}/api/health`, { signal: AbortSignal.timeout(1000), redirect: "error" });
        const body = response.ok ? await response.json() as { app?: string; version?: string } : null;
        if (body?.app === "openmausbot" && body.version === version) return;
      } catch { /* bounded startup retry */ }
      await new Promise(resolve => setTimeout(resolve, 200));
    } while (Date.now() < end);
    throw new Error(`Health check failed for ${version} on loopback port ${job.port}`);
  };
  try {
    await new Promise(resolve => setTimeout(resolve, 250));
    if (!priorRef?.startsWith("file:vendor/") || !existsSync(resolve(job.appDir, priorRef.slice(5)))) throw new Error("Previous vendor artifact is missing; rollback cannot be guaranteed");
    await verifyArtifact(job.artifact, job.plan.sha256);
    // Preserve recovery inputs on disk before any mutation.
    writeFileSync(join(job.lock, "package.json.before"), original, { mode: 0o600 });
    if (oldLock) writeFileSync(join(job.lock, "package-lock.json.before"), oldLock, { mode: 0o600 });
    const name = `openmausbot-${job.plan.target}-${job.plan.sha256}.tgz`;
    await copyFile(job.artifact, join(job.appDir, "vendor", name));
    await progress("installing");
    writeJson(pkgPath, { ...previous, dependencies: { ...previous.dependencies, openmausbot: `file:vendor/${name}` } });
    swapped = true;
    await install();
    const installed = readJson<{ version?: string }>(join(job.appDir, "node_modules", "openmausbot", "package.json"), {});
    if (installed.version !== job.plan.target) throw new Error("Artifact package version does not match the reviewed target");
    await progress("restarting"); await restart();
    await progress("checking-health"); await health(job.plan.target);
    result.current = job.plan.target;
    await progress("applied");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!swapped) { await progress("failed", message); }
    else {
      await progress("rolling-back", message);
      try {
        writeFileSync(pkgPath, original);
        if (oldLock) writeFileSync(lockPath, oldLock); else rmSync(lockPath, { force: true });
        await install(); await restart(); await health(job.plan.current);
        result.current = job.plan.current;
        await progress("rolled-back", message);
      } catch (rollbackError) {
        await progress("rollback-failed", `${message}; rollback: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}. Recovery files retained in ${job.lock}`);
      }
    }
  } finally {
    // Fail closed after an incomplete rollback: retain lock + recovery inputs.
    if (result.status !== "rollback-failed") rmSync(job.lock, { recursive: true, force: true });
    await rm(job.workDir, { recursive: true, force: true });
  }
}
