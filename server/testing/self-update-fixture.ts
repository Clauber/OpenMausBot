import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { create } from "tar";
import { SelfUpdater, type UpdaterOptions } from "../updater.ts";
import { createUpdaterRoutes } from "../routes/updater.ts";
import { json, readBody } from "../harness/http.ts";
import { isProxied, isAllowedOrigin } from "../request-auth.ts";
import { PASS } from "../routes/table.ts";
import { updateInProgress } from "../../shared/updater.ts";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const listen = (server: Server) => new Promise<string>(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
const close = (server: Server) => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  await exited; clearTimeout(timer);
}

/** Real npm installs + real processes. Only systemd's external boundary is synthetic. */
export async function createSelfUpdateFixture() {
  const temp = await mkdtemp(join(tmpdir(), "legion-updater-fixture-"));
  const appDir = join(temp, "app"), dataDir = join(temp, "data"), bin = join(temp, "bin");
  await Promise.all([mkdir(join(appDir, "vendor"), { recursive: true }), mkdir(dataDir), mkdir(bin), mkdir(join(temp, "home"))]);
  const workerPath = join(temp, "worker.mjs");
  await build({ entryPoints: [join(root, "server/updater.worker.ts")], outfile: workerPath, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const artifacts: Record<string, Buffer> = {}, hashes: Record<string, string> = {};
  for (const version of ["1.0.0", "2.0.0", "3.0.0"]) {
    const dir = join(temp, version, "package");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "openmausbot", version, type: "module", files: ["index.mjs"] }));
    await writeFile(join(dir, "index.mjs"), `import {createServer} from 'node:http';\nconst server=createServer((req,res)=>{res.writeHead(${version === "3.0.0" ? 503 : 200},{'content-type':'application/json'});res.end(JSON.stringify({app:'openmausbot',version:${JSON.stringify(version)},pid:process.pid}));});\nserver.listen(Number(process.argv[2]),'127.0.0.1');\nprocess.once('SIGTERM',()=>server.close(()=>process.exit(0)));\n`);
    const tgz = join(appDir, "vendor", `${version}.tgz`);
    await create({ gzip: true, file: tgz, cwd: dirname(dir) }, ["package"]);
    artifacts[version] = await readFile(tgz);
    hashes[version] = createHash("sha256").update(artifacts[version]!).digest("hex");
  }
  await writeFile(join(appDir, "package.json"), JSON.stringify({ private: true, dependencies: { openmausbot: "file:vendor/1.0.0.tgz" } }));
  const environment = { PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, HOME: join(temp, "home"), TMPDIR: temp, USERPROFILE: join(temp, "home"), ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}) };
  await execute("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", join(temp, "initial-cache")], { cwd: appDir, env: environment });
  const portProbe = createServer();
  const healthUrl = await listen(portProbe);
  const port = Number(new URL(healthUrl).port);
  await close(portProbe);
  let service: ChildProcess | undefined;
  const workerPidFile = join(temp, "worker-pids");
  const restarts: string[] = [];
  let serviceLog = "";
  const restart = async () => {
    await stop(service);
    service = spawn(process.execPath, [join(appDir, "node_modules/openmausbot/index.mjs"), String(port)], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
    service.stderr!.on("data", chunk => { serviceLog += chunk; });
  };
  await restart();
  const controller = createServer(async (req, res) => {
    try {
      if (req.url !== "/restart" || req.method !== "POST") return json(res, 404, {});
      restarts.push((await readBody(req) as { unit: string }).unit);
      await restart(); json(res, 200, { ok: true });
    } catch (error) { json(res, 500, { error: String(error) }); }
  });
  const controllerUrl = await listen(controller);
  await writeFile(join(bin, "systemctl"), `#!${process.execPath}\nconst args=process.argv.slice(2);if(args[0]!=='--user'||args[2]!=='legion-fixture.service')process.exit(97);if(args[1]==='show'){console.log('loaded');}else if(args[1]==='restart'){fetch(${JSON.stringify(controllerUrl + "/restart")},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({unit:args[2]})}).then(r=>{if(!r.ok)process.exit(98)}).catch(()=>process.exit(99));}else process.exit(96);\n`, { mode: 0o700 });
  await writeFile(join(bin, "systemd-run"), `#!${process.execPath}\nconst {spawn}=require('node:child_process');const args=process.argv.slice(2);const at=args.findIndex(a=>a===${JSON.stringify(process.execPath)});if(at<0)process.exit(95);const child=spawn(args[at],args.slice(at+1),{detached:true,stdio:'ignore',env:process.env});require('node:fs').appendFileSync(${JSON.stringify(workerPidFile)},String(child.pid)+'\\n');console.log(child.pid);child.unref();\n`, { mode: 0o700 });
  let releases = ["1.0.0", "2.0.0"], badHash = false;
  const downloads: Record<string, number> = {};
  const registry = createServer((req, res) => {
    if (req.url === "/index.json") return json(res, 200, { releases: releases.map(version => ({ version, url: `${version}.tgz`, sha256: badHash ? "0".repeat(64) : hashes[version], changelog: `CHANGELOG ${version}: fixture update delta`, channel: "stable" })) });
    const version = req.url?.slice(1).replace(/\.tgz$/, "");
    if (!version || !artifacts[version]) return json(res, 404, {});
    downloads[version] = (downloads[version] ?? 0) + 1;
    res.writeHead(200, { "content-type": "application/gzip" }); res.end(artifacts[version]);
  });
  const registryUrl = await listen(registry);
  let config: ReturnType<UpdaterOptions["config"]> = { enabled: true, registryUrl: registryUrl + "/", unit: "legion-fixture.service" };
  const updater = new SelfUpdater({ config: () => config, appDir, dataDir, port, version: "1.0.0", docker: false, workerPath, commandEnv: environment, healthTimeoutMs: 2000, runningTurns: () => 2 });
  const route = createUpdaterRoutes(updater);
  const apiServer = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    try {
      if (!isAllowedOrigin(req.headers.origin)) return json(res, 403, { error: "origin refused" });
      const handled = await route({ req, res, url, path: url.pathname, method: req.method!, auth: isProxied(req) || req.headers.authorization ? { kind: "loopback", scopes: ["client"], trust: "service" } : { kind: "loopback", scopes: ["admin", "client"] }, json, readBody });
      if (handled === PASS) json(res, 404, {});
    } catch (error) { json(res, 500, { error: String(error) }); }
  });
  const apiUrl = await listen(apiServer);
  const request = async (method: string, path: string, body?: unknown, headers?: Record<string, string>) => {
    const response = await fetch(apiUrl + path, { method, headers: { origin: apiUrl, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
    return { status: response.status, body: await response.json() as any };
  };
  let closed = false;
  return {
    temp, appDir, dataDir, apiUrl, healthUrl, hashes, downloads, restarts, updater, request,
    setReleases(next: string[], mismatch = false) { releases = next; badHash = mismatch; },
    setConfig(next: typeof config) { config = next; },
    config: () => config,
    async waitForResult() {
      const end = Date.now() + 30_000;
      while (Date.now() < end) {
        const state = updater.state();
        if (state.enabled && state.lastApply && !updateInProgress(state.lastApply.status)) return state;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error(`Update timed out: ${JSON.stringify(updater.state())}; ${serviceLog}`);
    },
    async close() {
      if (closed) return; closed = true;
      // Wait for the owned worker to finish before deleting its cwd/artifacts.
      const state = updater.state();
      if (state.enabled && state.busy) {
        try { await this.waitForResult(); } catch { /* capture owned PIDs below */ }
      }
      const workerPids = await readFile(workerPidFile, "utf8").then(value => value.trim().split("\n").map(Number)).catch(() => []);
      for (const pid of workerPids) { try { process.kill(pid, "SIGTERM"); } catch { /* exited */ } }
      await stop(service);
      await Promise.all([close(apiServer), close(registry), close(controller)]);
      await rm(temp, { recursive: true, force: true });
    },
  };
}

export async function verifyFixtureHealth(url: string, version: string) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    try {
      const response = await fetch(url + "/api/health", { signal: AbortSignal.timeout(500) });
      if (response.ok) { const body = await response.json() as { version: string }; if (body.version === version) return body; }
    } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`Fixture health did not report ${version}`);
}
