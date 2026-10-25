import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { SelfUpdater, compareVersions } from "./updater.ts";
import { verifySelfUpdate } from "../scripts/verify-self-update.ts";

describe("self-update isolated HTTP/npm/service fixture", () => {
  it("uses SemVer precedence rather than lexical order", () => {
    expect(compareVersions("2.10.0", "2.9.0")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0", "2.0.0-rc.10")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0-rc.10", "2.0.0-rc.9")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0+new", "2.0.0+old")).toBe(0);
    expect(() => compareVersions("2.0.0-01", "1.0.0")).toThrow("Invalid version");
  });
  it("reads a local directory index, filters channels, and leaves checkout/docker apply manual", async () => {
    const dir = await mkdtemp(join(tmpdir(), "legion-updater-index-"));
    try {
      const content = Buffer.from("local fixture artifact");
      await writeFile(join(dir, "release.tgz"), content);
      const sha256 = createHash("sha256").update(content).digest("hex");
      await writeFile(join(dir, "index.json"), JSON.stringify({ releases: [
        { version: "2.0.0", url: "release.tgz", sha256 },
        { version: "9.0.0-rc.1", url: "release.tgz", sha256 },
        { version: "8.0.0", channel: "preview", url: "release.tgz", sha256 },
      ] }));
      const options = { config: () => ({ enabled: true, registryUrl: dir, unit: "fixture.service" }), dataDir: dir, port: 1, version: "1.0.0", docker: false };
      const checkout = new SelfUpdater(options);
      expect(await checkout.plan()).toMatchObject({ current: "1.0.0", target: "2.0.0", channel: "stable", sha256 });
      expect(await checkout.apply()).toMatchObject({ layout: "checkout", lastApply: { status: "manual" } });
      const docker = new SelfUpdater({ ...options, docker: true });
      expect(await docker.apply()).toMatchObject({ layout: "docker", lastApply: { status: "manual" } });
      const preview = new SelfUpdater({ ...options, config: () => ({ enabled: true, registryUrl: dir, channel: "preview" }) });
      expect(await preview.plan()).toMatchObject({ target: "8.0.0", channel: "preview" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("plans, applies, verifies health, rolls back, gates access and refuses bad hashes", async () => {
    const evidence = await verifySelfUpdate();
    expect(evidence.plan.current).toBe("1.0.0");
    expect(evidence.plan.target).toBe("2.0.0");
    expect(evidence.applied.current).toBe("2.0.0");
    expect(evidence.rollback.current).toBe("2.0.0");
    expect(evidence.rollback.lastApply?.status).toBe("rolled-back");
    expect(evidence.disabled).toEqual([{ enabled: false }, { enabled: false }, { enabled: false }]);
    expect(evidence.badHash).toMatch(/SHA-256 mismatch/);
  }, 120_000);
});
