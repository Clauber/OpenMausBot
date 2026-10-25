import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, posix, resolve } from "node:path";
import { extract, list } from "tar";

import { resolveZcodeServerAsset, type ZcodeServerAsset } from "./release.ts";

export type { ZcodeServerAsset } from "./release.ts";
export { resolveZcodeServerAsset } from "./release.ts";

export interface ZcodeServerInstall {
  /** Folder that holds `bin/zcode` and `manifest.json` with product "zcode-server". */
  root: string;
  version: string;
  source: "configured" | "managed" | "path";
}

const MANIFEST_MAX_BYTES = 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 45 * 60_000;
const PROGRESS_INTERVAL_MS = 250;
// A lock left by a crashed installer expires after the longest possible download plus slack.
const LOCK_STALE_MS = 60 * 60_000;
const NOT_AVAILABLE = "ZCode server is not available for this platform.";
const PATH_NAMES = ["zcode-server", "zcode", "zcodium"];

const toolsRoot = (dataDir: string) => join(dataDir, "tools", "zcode-server");

/** A server has `bin/zcode` and a `manifest.json` naming the server product. The plain `zcode` CLI has no manifest, so it never qualifies. */
async function inspect(root: string): Promise<{ version: string; target?: string } | null> {
  try {
    const [binary, manifest] = await Promise.all([stat(join(root, "bin", "zcode")), stat(join(root, "manifest.json"))]);
    if (!binary.isFile() || !manifest.isFile() || manifest.size > MANIFEST_MAX_BYTES) return null;
    const parsed: unknown = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { product, appVersion, target } = parsed as Record<string, unknown>;
    if (product !== "zcode-server" || typeof appVersion !== "string" || appVersion === "") return null;
    return { version: appVersion, target: typeof target === "string" ? target : undefined };
  } catch {
    return null;
  }
}

/** A path to the server root, or to its `bin/zcode` (possibly through a symlink). */
async function inspectCandidate(path: string): Promise<{ root: string; version: string } | null> {
  const direct = await inspect(path);
  if (direct) return { root: path, version: direct.version };
  try {
    const root = dirname(dirname(await realpath(path)));
    const found = await inspect(root);
    return found ? { root, version: found.version } : null;
  } catch {
    return null;
  }
}

export async function detectZcodeServer(options: {
  dataDir: string;
  configuredPath?: string;
  env: NodeJS.ProcessEnv;
}): Promise<ZcodeServerInstall | null> {
  const configured = options.configuredPath?.trim();
  if (configured) {
    const found = await inspectCandidate(resolve(configured));
    if (found) return { ...found, source: "configured" };
  }
  const managedRoot = join(toolsRoot(options.dataDir), "current");
  const managed = await inspect(managedRoot);
  if (managed) return { root: managedRoot, version: managed.version, source: "managed" };
  const pathValue = process.platform === "win32"
    ? Object.entries(options.env).findLast(([key]) => key.toUpperCase() === "PATH")?.[1]
    : options.env.PATH;
  for (const entry of (pathValue ?? "").split(delimiter)) {
    if (!entry.trim()) continue;
    for (const name of PATH_NAMES) {
      // Only a binary that resolves into a manifest-bearing root counts.
      try {
        const root = dirname(dirname(await realpath(join(entry.trim(), name))));
        const found = await inspect(root);
        if (found) return { root, version: found.version, source: "path" };
      } catch {
        // Not on this PATH entry.
      }
    }
  }
  return null;
}

export function zcodeServerManagedInstallAvailable(): boolean {
  return resolveZcodeServerAsset() !== null;
}

const insideRoot = (path: string) => path === "/r" || path.startsWith("/r/");

/** Returns a reason when the archive holds an entry that could land outside its own folder. */
async function unsafeEntry(archive: string, topFolder: string): Promise<string | null> {
  let reason: string | null = null;
  await list({
    file: archive,
    onReadEntry: (entry) => {
      const path = entry.path;
      const parts = path.split(/[\\/]/u);
      if (reason) return;
      if (path === "" || path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/u.test(path) || parts.includes("..")) {
        reason = "an entry path leaves the install folder";
      } else if (parts[0] !== topFolder) {
        reason = "an entry sits outside the expected top folder";
      } else if (entry.type === "SymbolicLink" || entry.type === "Link") {
        const target = entry.linkpath ?? "";
        const base = entry.type === "SymbolicLink" ? posix.dirname(path) : "";
        if (target === "" || target.startsWith("/") || /^[A-Za-z]:/u.test(target) || !insideRoot(posix.resolve("/r", base, target.replaceAll("\\", "/")))) {
          reason = "a link points outside the install folder";
        }
      } else if (entry.type !== "File" && entry.type !== "Directory") {
        reason = "an entry is neither a file, a folder nor a link";
      }
    },
  });
  return reason;
}

type ProgressFn = (downloaded: number, total: number | null) => void;

async function download(asset: ZcodeServerAsset, destination: string, signal: AbortSignal, fetchImpl: typeof fetch, onProgress?: ProgressFn): Promise<void> {
  const response = await fetchImpl(asset.url, { signal, redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`The ZCode server download failed (${response.status}).`);
  const handle = await open(destination, "wx", 0o600);
  const hash = createHash("sha256");
  let downloaded = 0;
  let lastProgress = 0;
  try {
    for await (const raw of response.body as unknown as AsyncIterable<Uint8Array>) {
      signal.throwIfAborted();
      downloaded += raw.byteLength;
      if (downloaded > asset.archiveBytes) throw new Error("The ZCode server download exceeded the expected release size.");
      hash.update(raw);
      await handle.writeFile(raw);
      const now = Date.now();
      if (now - lastProgress >= PROGRESS_INTERVAL_MS) {
        lastProgress = now;
        onProgress?.(downloaded, asset.archiveBytes);
      }
    }
  } finally {
    await handle.close();
  }
  if (downloaded !== asset.archiveBytes || hash.digest("hex") !== asset.sha256) {
    throw new Error("The ZCode server download failed its size or SHA-256 check. Nothing was installed.");
  }
  onProgress?.(downloaded, asset.archiveBytes);
}

async function lockIsStale(lock: string): Promise<boolean> {
  try {
    if (Date.now() - (await stat(lock)).mtimeMs > LOCK_STALE_MS) return true;
    const pid = Number(await readFile(join(lock, "pid"), "utf8").catch(() => ""));
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return Reflect.get(error as object, "code") === "ESRCH";
    }
  } catch {
    return true;
  }
}

/** The lock directory keeps a second OMB process off the same dataDir; the caller's map covers this process. */
async function acquireLock(lock: string): Promise<() => Promise<void>> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await mkdir(lock);
      await writeFile(join(lock, "pid"), String(process.pid));
      return () => rm(lock, { recursive: true, force: true });
    } catch (error) {
      if (Reflect.get(error as object, "code") !== "EEXIST") throw error;
      if (attempt > 0 || !(await lockIsStale(lock))) throw new Error("Another ZCode server installation is already running.");
      await rm(lock, { recursive: true, force: true });
    }
  }
}

interface InstallOptions {
  dataDir: string;
  signal?: AbortSignal;
  onProgress?: ProgressFn;
  fetchImpl?: typeof fetch;
  asset?: ZcodeServerAsset;
}

async function installOnce(options: InstallOptions): Promise<ZcodeServerInstall> {
  const asset = options.asset ?? resolveZcodeServerAsset();
  if (!asset) throw new Error(NOT_AVAILABLE);
  const tools = toolsRoot(options.dataDir);
  const versions = join(tools, "versions");
  const current = join(tools, "current");
  await mkdir(versions, { recursive: true });
  const releaseLock = await acquireLock(join(tools, "install.lock"));
  const staging = join(tools, "tmp", randomUUID());
  try {
    const existing = await inspect(current);
    if (existing?.version === asset.version && existing.target === asset.target) {
      return { root: current, version: existing.version, source: "managed" };
    }
    await mkdir(staging, { recursive: true });
    const archive = join(staging, "download.tar.gz");
    const signal = AbortSignal.any([AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), ...(options.signal ? [options.signal] : [])]);
    await download(asset, archive, signal, options.fetchImpl ?? fetch, options.onProgress);

    const topFolder = `zcode-server-${asset.target}`;
    const unsafe = await unsafeEntry(archive, topFolder);
    if (unsafe) throw new Error(`The ZCode server archive is unsafe: ${unsafe}.`);
    const unpacked = join(staging, "unpacked");
    await mkdir(unpacked);
    await extract({ file: archive, cwd: unpacked, strict: true, preserveOwner: false });

    const extracted = join(unpacked, topFolder);
    const manifest = await inspect(extracted);
    if ((await readdir(unpacked)).join() !== topFolder || manifest?.version !== asset.version || manifest.target !== asset.target) {
      throw new Error("The downloaded ZCode server does not match the expected release.");
    }
    const binary = join(extracted, "bin", "zcode");
    if (((await stat(binary)).mode & 0o111) === 0) await chmod(binary, 0o755);

    const destination = join(versions, asset.version);
    await rm(destination, { recursive: true, force: true });
    await rename(extracted, destination);
    // A symlink renamed over `current` swaps the active install atomically.
    const link = join(tools, `.current-${randomUUID()}`);
    await symlink(join("versions", asset.version), link);
    await rename(link, current);
    return { root: current, version: asset.version, source: "managed" };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    await releaseLock().catch(() => undefined);
  }
}

const installs = new Map<string, Promise<ZcodeServerInstall>>();

/** Windows has no pinned asset, so this rejects there. A second call for the same dataDir shares the running install. */
export function installZcodeServer(options: InstallOptions): Promise<ZcodeServerInstall> {
  const key = toolsRoot(options.dataDir);
  const running = installs.get(key);
  if (running) return running;
  const started = installOnce(options).finally(() => installs.delete(key));
  installs.set(key, started);
  return started;
}
