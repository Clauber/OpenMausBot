import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "tar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectZcodeServer, installZcodeServer, zcodeServerManagedInstallAvailable, type ZcodeServerAsset } from "./install.ts";
import { resolveZcodeServerAsset } from "./release.ts";

const TARGET = "linux-x64";
const VERSION = "3.16.2";
const TOP = `zcode-server-${TARGET}`;
const manifestJson = (overrides: Record<string, unknown> = {}) => JSON.stringify({ product: "zcode-server", target: TARGET, appVersion: VERSION, ...overrides });

let scratch: string;
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "zcode-install-test-"));
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function writeServer(root: string, input: { manifest?: string | null; mode?: number } = {}) {
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(join(root, "bin", "zcode"), "#!/bin/sh\n", { mode: input.mode ?? 0o755 });
  const manifest = input.manifest === undefined ? manifestJson() : input.manifest;
  if (manifest !== null) await writeFile(join(root, "manifest.json"), manifest);
}

type Kind = "ok" | "parent" | "absolute" | "symlink" | "other-top";

/** `parent` and `absolute` need preservePaths, otherwise tar rewrites the unsafe entry names while packing. */
async function buildArchive(kind: Kind): Promise<Buffer> {
  const work = await mkdtemp(join(scratch, "archive-"));
  const topName = kind === "other-top" ? "other" : TOP;
  await writeServer(join(work, "server", topName), { mode: 0o644 });
  await mkdir(join(work, "sub"));
  if (kind === "symlink") await symlink("../../outside", join(work, "server", topName, "evil"));
  const file = join(work, "out.tar.gz");
  const options = { gzip: true, file, cwd: join(work, "server") };
  if (kind === "parent") await create({ ...options, cwd: join(work, "sub"), preservePaths: true }, [`../server/${topName}`]);
  else if (kind === "absolute") await create({ ...options, preservePaths: true }, [join(work, "server", topName)]);
  else await create(options, [topName]);
  return readFile(file);
}

const assetFor = (bytes: Buffer, overrides: Partial<ZcodeServerAsset> = {}): ZcodeServerAsset => ({
  version: VERSION,
  target: TARGET,
  url: "https://example.com/zcode-server.tar.gz",
  sha256: createHash("sha256").update(bytes).digest("hex"),
  archiveBytes: bytes.length,
  ...overrides,
});

function fakeFetch(body: Buffer, init: { status?: number; chunk?: number } = {}) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    if (init.status) return new Response(null, { status: init.status });
    const chunk = init.chunk ?? body.length;
    return new Response(
      new ReadableStream({
        start(controller) {
          for (let offset = 0; offset < body.length; offset += chunk) controller.enqueue(body.subarray(offset, offset + chunk));
          controller.close();
        },
      }),
    );
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const toolsDir = () => join(scratch, "tools", "zcode-server");
const leftovers = async () => {
  const names: string[] = [];
  for (const dir of ["versions", "tmp"]) names.push(...(await readdir(join(toolsDir(), dir)).catch(() => [])));
  return names;
};
const exists = (path: string) => stat(path).then(() => true, () => false);

describe("detectZcodeServer", () => {
  it("accepts a configured root or its bin/zcode", async () => {
    await writeServer(join(scratch, "server"));
    expect(await detectZcodeServer({ dataDir: scratch, configuredPath: join(scratch, "server"), env: {} })).toEqual({ root: join(scratch, "server"), version: VERSION, source: "configured" });
    const found = await detectZcodeServer({ dataDir: scratch, configuredPath: join(scratch, "server", "bin", "zcode"), env: {} });
    expect(found).toMatchObject({ version: VERSION, source: "configured" });
  });

  it("finds the managed current folder", async () => {
    const current = join(toolsDir(), "current");
    await writeServer(current);
    expect(await detectZcodeServer({ dataDir: scratch, env: {} })).toEqual({ root: current, version: VERSION, source: "managed" });
  });

  it.each(["zcode-server", "zcode", "zcodium"])("finds a server linked into PATH as %s", async (name) => {
    const root = join(scratch, "opt", "server");
    await writeServer(root);
    await mkdir(join(scratch, "bin"));
    await symlink(join(root, "bin", "zcode"), join(scratch, "bin", name));
    const found = await detectZcodeServer({ dataDir: scratch, env: { PATH: `/nonexistent:${join(scratch, "bin")}` } });
    expect(found).toMatchObject({ root: await realpath(root), version: VERSION, source: "path" });
  });

  it("prefers configured over managed over PATH", async () => {
    await writeServer(join(scratch, "configured"), { manifest: manifestJson({ appVersion: "1.0.0" }) });
    await writeServer(join(toolsDir(), "current"), { manifest: manifestJson({ appVersion: "2.0.0" }) });
    await writeServer(join(scratch, "other"), { manifest: manifestJson({ appVersion: "3.0.0" }) });
    await mkdir(join(scratch, "bin"));
    await symlink(join(scratch, "other", "bin", "zcode"), join(scratch, "bin", "zcode"));
    const env = { PATH: join(scratch, "bin") };
    expect((await detectZcodeServer({ dataDir: scratch, configuredPath: join(scratch, "configured"), env }))?.version).toBe("1.0.0");
    expect((await detectZcodeServer({ dataDir: scratch, env }))?.version).toBe("2.0.0");
    await rm(join(toolsDir(), "current"), { recursive: true });
    expect((await detectZcodeServer({ dataDir: scratch, env }))?.version).toBe("3.0.0");
  });

  it("falls through a bad configured path", async () => {
    await writeServer(join(toolsDir(), "current"));
    expect((await detectZcodeServer({ dataDir: scratch, configuredPath: join(scratch, "missing"), env: {} }))?.source).toBe("managed");
  });

  it.each([
    ["a plain CLI without manifest.json", null],
    ["another product", manifestJson({ product: "zcode-cli" })],
    ["an empty appVersion", manifestJson({ appVersion: "" })],
    ["an unparsable manifest", "{"],
    ["a non-object manifest", "[]"],
  ])("rejects %s as a server", async (_name, manifest) => {
    await writeServer(join(scratch, "cli"), { manifest });
    await mkdir(join(scratch, "bin"));
    await symlink(join(scratch, "cli", "bin", "zcode"), join(scratch, "bin", "zcode"));
    expect(await detectZcodeServer({ dataDir: scratch, configuredPath: join(scratch, "cli"), env: { PATH: join(scratch, "bin") } })).toBeNull();
  });

  it("returns null when nothing is installed and PATH is empty", async () => {
    expect(await detectZcodeServer({ dataDir: scratch, env: {} })).toBeNull();
  });
});

describe("installZcodeServer", () => {
  it("downloads, verifies, extracts and activates the release", async () => {
    const archive = await buildArchive("ok");
    const { fetchImpl, calls } = fakeFetch(archive, { chunk: 1024 });
    const progress: Array<[number, number | null]> = [];
    const installed = await installZcodeServer({ dataDir: scratch, asset: assetFor(archive), fetchImpl, onProgress: (done, total) => progress.push([done, total]) });
    const current = join(toolsDir(), "current");
    expect(installed).toEqual({ root: current, version: VERSION, source: "managed" });
    expect(calls).toEqual(["https://example.com/zcode-server.tar.gz"]);
    expect(await readlink(current)).toBe(join("versions", VERSION));
    expect((await stat(join(current, "bin", "zcode"))).mode & 0o111).not.toBe(0);
    expect(await leftovers()).toEqual([VERSION]);
    expect(await exists(join(toolsDir(), "install.lock"))).toBe(false);
    expect(progress.at(-1)).toEqual([archive.length, archive.length]);
    expect(await detectZcodeServer({ dataDir: scratch, env: {} })).toEqual({ root: current, version: VERSION, source: "managed" });
  });

  it("does not download again when the pinned version is already current", async () => {
    const archive = await buildArchive("ok");
    const first = fakeFetch(archive);
    await installZcodeServer({ dataDir: scratch, asset: assetFor(archive), fetchImpl: first.fetchImpl });
    const second = fakeFetch(archive);
    expect((await installZcodeServer({ dataDir: scratch, asset: assetFor(archive), fetchImpl: second.fetchImpl })).version).toBe(VERSION);
    expect(second.calls).toEqual([]);
  });

  it("replaces an older install through the symlink swap", async () => {
    await writeServer(join(toolsDir(), "versions", "3.0.0"), { manifest: manifestJson({ appVersion: "3.0.0" }) });
    await symlink(join("versions", "3.0.0"), join(toolsDir(), "current"));
    const archive = await buildArchive("ok");
    await installZcodeServer({ dataDir: scratch, asset: assetFor(archive), fetchImpl: fakeFetch(archive).fetchImpl });
    expect(await readlink(join(toolsDir(), "current"))).toBe(join("versions", VERSION));
  });

  it("shares one install between concurrent callers", async () => {
    const archive = await buildArchive("ok");
    const { fetchImpl, calls } = fakeFetch(archive);
    const options = { dataDir: scratch, asset: assetFor(archive), fetchImpl };
    const [a, b] = await Promise.all([installZcodeServer(options), installZcodeServer(options)]);
    expect(a).toEqual(b);
    expect(calls).toHaveLength(1);
  });

  it("rejects a download whose SHA-256 differs and leaves nothing behind", async () => {
    const archive = await buildArchive("ok");
    await expect(installZcodeServer({ dataDir: scratch, asset: assetFor(archive, { sha256: "0".repeat(64) }), fetchImpl: fakeFetch(archive).fetchImpl })).rejects.toThrow(/SHA-256/u);
    expect(await exists(join(toolsDir(), "current"))).toBe(false);
    expect(await leftovers()).toEqual([]);
  });

  it("rejects a short and an oversized download", async () => {
    const archive = await buildArchive("ok");
    await expect(installZcodeServer({ dataDir: scratch, asset: assetFor(archive, { archiveBytes: archive.length + 1 }), fetchImpl: fakeFetch(archive).fetchImpl })).rejects.toThrow(/size or SHA-256/u);
    await expect(installZcodeServer({ dataDir: scratch, asset: assetFor(archive, { archiveBytes: archive.length - 1 }), fetchImpl: fakeFetch(archive).fetchImpl })).rejects.toThrow(/exceeded/u);
    expect(await leftovers()).toEqual([]);
  });

  it("rejects an HTTP error", async () => {
    const archive = await buildArchive("ok");
    await expect(installZcodeServer({ dataDir: scratch, asset: assetFor(archive), fetchImpl: fakeFetch(archive, { status: 404 }).fetchImpl })).rejects.toThrow(/404/u);
    expect(await leftovers()).toEqual([]);
  });

  it.each(["parent", "absolute", "symlink", "other-top"] as const)("rejects an unsafe archive (%s) before extracting", async (kind) => {
    const archive = await buildArchive(kind);
    await expect(installZcodeServer({ dataDir: scratch, asset: assetFor(archive), fetchImpl: fakeFetch(archive).fetchImpl })).rejects.toThrow(/unsafe/u);
    expect(await exists(join(toolsDir(), "current"))).toBe(false);
    expect(await leftovers()).toEqual([]);
  });

  it("rejects a release whose manifest names another version", async () => {
    const archive = await buildArchive("ok");
    await expect(installZcodeServer({ dataDir: scratch, asset: assetFor(archive, { version: "3.16.3" }), fetchImpl: fakeFetch(archive).fetchImpl })).rejects.toThrow(/expected release/u);
    expect(await leftovers()).toEqual([]);
  });

  it("stops on abort and cleans up", async () => {
    const archive = await buildArchive("ok");
    const controller = new AbortController();
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(archive.subarray(0, 10));
            controller.abort();
          },
        }),
      )) as typeof fetch;
    await expect(installZcodeServer({ dataDir: scratch, asset: assetFor(archive), fetchImpl, signal: controller.signal })).rejects.toThrow();
    expect(await leftovers()).toEqual([]);
    expect(await exists(join(toolsDir(), "install.lock"))).toBe(false);
  });

  it("refuses to run beside a live installer but clears a dead one's lock", async () => {
    const archive = await buildArchive("ok");
    const lock = join(toolsDir(), "install.lock");
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, "pid"), String(process.pid));
    const options = { dataDir: scratch, asset: assetFor(archive), fetchImpl: fakeFetch(archive).fetchImpl };
    await expect(installZcodeServer(options)).rejects.toThrow(/already running/u);
    expect(await exists(lock)).toBe(true);
    await writeFile(join(lock, "pid"), "2147483646");
    expect((await installZcodeServer(options)).version).toBe(VERSION);
    expect(await exists(lock)).toBe(false);
  });

  it("rejects where no asset is published", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      expect(zcodeServerManagedInstallAvailable()).toBe(false);
      await expect(installZcodeServer({ dataDir: scratch })).rejects.toThrow(/not available/u);
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  });

  it("reports the managed install as available on a published platform", () => {
    expect(zcodeServerManagedInstallAvailable()).toBe(resolveZcodeServerAsset() !== null);
  });
});

// Opt-in: ZCODE_SERVER_ARCHIVE=<official .tar.gz> ZCODE_SERVER_ARCHIVE_SHA256=<its hash>.
const realArchive = process.env.ZCODE_SERVER_ARCHIVE;
const realSha256 = process.env.ZCODE_SERVER_ARCHIVE_SHA256;
describe.skipIf(!realArchive || !realSha256)("real official archive", () => {
  it("installs the pinned release it matches", async () => {
    const pinned = (["linux", "darwin"] as const)
      .flatMap((platform) => ["x64", "arm64"].map((arch) => resolveZcodeServerAsset(platform, arch)))
      .find((asset) => asset?.sha256 === realSha256);
    expect(pinned).toBeTruthy();
    const bytes = await readFile(realArchive!);
    const installed = await installZcodeServer({ dataDir: scratch, asset: pinned!, fetchImpl: fakeFetch(bytes, { chunk: 1 << 20 }).fetchImpl });
    expect(installed).toMatchObject({ version: pinned!.version, source: "managed" });
    expect(await detectZcodeServer({ dataDir: scratch, env: {} })).toMatchObject({ source: "managed", version: pinned!.version });
    expect((await stat(join(installed.root, "bin", "zcode"))).mode & 0o111).not.toBe(0);
    expect(await leftovers()).toEqual([pinned!.version]);
  }, 180_000);
});
