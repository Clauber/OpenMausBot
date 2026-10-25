import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createStealthRuntime,
  forgetCdpPort,
  gpuEnv,
  isValidStealthSession,
  loadOrCreateFingerprint,
  reserveCdpPort,
  stealthProfileDir,
} from "./runtime.ts";
import { buildEvasionScript } from "./evasions.ts";

const CHROME = process.env.OMB_TEST_CHROME ?? "/opt/google/chrome/chrome";

describe("stealth browser runtime", () => {
  let stateDir: string;
  let profilesDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "stealth-state-"));
    profilesDir = mkdtempSync(join(tmpdir(), "stealth-profiles-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(profilesDir, { recursive: true, force: true });
  });

  describe("GPU userspace", () => {
    it("points Chrome at the configured GL/Vulkan libraries and keeps the existing library path", () => {
      expect(gpuEnv({})).toEqual({});
      expect(gpuEnv({ OMB_BROWSER_GPU_DIR: "/gpu", LD_LIBRARY_PATH: "/usr/local/lib" })).toEqual({
        LD_LIBRARY_PATH: `${join("/gpu", "lib")}:/usr/local/lib`,
        VK_ICD_FILENAMES: join("/gpu", "share", "nvidia_icd.json"),
        __EGL_VENDOR_LIBRARY_FILENAMES: join("/gpu", "share", "10_nvidia.json"),
      });
    });
  });

  describe("session names", () => {
    it("accepts the sanitized ids browserSessionId produces and rejects traversal", () => {
      expect(isValidStealthSession("bot-abc123")).toBe(true);
      expect(isValidStealthSession("guest-7f3c9a2e-uuid")).toBe(true);
      expect(isValidStealthSession("a".repeat(96))).toBe(true);
      expect(isValidStealthSession("../etc")).toBe(false);
      expect(isValidStealthSession("")).toBe(false);
      expect(isValidStealthSession("bad name")).toBe(false);
      expect(isValidStealthSession("x".repeat(97))).toBe(false);
    });
  });

  describe("CDP port reservation", () => {
    it("hands out the base port first and records it, reusing it next time", async () => {
      const first = await reserveCdpPort(stateDir, 19500, "bot-a");
      expect(first).toBe(19500);
      expect(JSON.parse(readFileSync(join(stateDir, "debug-ports.json"), "utf-8"))).toEqual({ "bot-a": 19500 });
      const second = await reserveCdpPort(stateDir, 19500, "bot-a");
      expect(second).toBe(19500);
    });

    it("skips a busy port and never hands the same port to two sessions", async () => {
      const blocker = createServer();
      await new Promise<void>((resolve) => blocker.listen({ port: 19500, host: "127.0.0.1" }, resolve));
      try {
        expect(await reserveCdpPort(stateDir, 19500, "bot-a")).toBe(19501);
        expect(await reserveCdpPort(stateDir, 19500, "bot-b")).toBe(19502);
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }
    });

    it("moves a session off a recorded port that something else now holds", async () => {
      writeFileSync(join(stateDir, "debug-ports.json"), JSON.stringify({ "bot-a": 19500 }));
      const blocker = createServer();
      await new Promise<void>((resolve) => blocker.listen({ port: 19500, host: "127.0.0.1" }, resolve));
      try {
        expect(await reserveCdpPort(stateDir, 19500, "bot-a")).toBe(19501);
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }
    });

    it("forgetCdpPort drops the recording so the port can be handed out again", async () => {
      writeFileSync(join(stateDir, "debug-ports.json"), JSON.stringify({ "bot-a": 19500, "bot-b": 19501 }));
      expect(forgetCdpPort(stateDir, "bot-a")).toBe(true);
      expect(forgetCdpPort(stateDir, "bot-a")).toBe(false);
      expect(JSON.parse(readFileSync(join(stateDir, "debug-ports.json"), "utf-8"))).toEqual({ "bot-b": 19501 });
    });
  });

  describe("fingerprints", () => {
    it("persists one identity per session and hands it back unchanged", async () => {
      const first = await loadOrCreateFingerprint(stateDir, "bot-a");
      const second = await loadOrCreateFingerprint(stateDir, "bot-a");
      expect(second).toEqual(first);
      expect(existsSync(join(stateDir, "bot-a-fingerprint.json"))).toBe(true);
      expect(first.fingerprint.navigator.userAgent).toMatch(/Chrome\//);
      expect(Object.keys(first.headers)).not.toHaveLength(0);
    });

    it("keeps each session's identity in its own file", async () => {
      // Fingerprint Suite generates realistic identities and may legitimately
      // produce the same popular one twice; what matters is that each session
      // keeps whichever it drew, per session.
      await loadOrCreateFingerprint(stateDir, "bot-a");
      await loadOrCreateFingerprint(stateDir, "bot-b");
      expect(existsSync(join(stateDir, "bot-a-fingerprint.json"))).toBe(true);
      expect(existsSync(join(stateDir, "bot-b-fingerprint.json"))).toBe(true);
    });
  });

  describe("evasion script", () => {
    it("is deterministic per session and stays minimal", async () => {
      const fingerprint = await loadOrCreateFingerprint(stateDir, "bot-a");
      const once = buildEvasionScript(fingerprint, "bot-a");
      expect(buildEvasionScript(fingerprint, "bot-a")).toBe(once);
      expect(once).toContain("canvasNoiseOffsets");
      expect(once).toContain("getFloatFrequencyData");
      expect(once).toContain("[native code]");
      // The measurable patches that made Cloudflare loop forever are gone.
      expect(once).not.toContain("WEBGL_VENDOR");
      expect(once).not.toContain("FontFaceSet");
      expect(once).not.toContain("RTCPeerConnection");
      // A different session seeds the canvas/audio noise differently.
      expect(buildEvasionScript(fingerprint, "bot-b")).not.toBe(once);
    });
  });

  it("profiles live one directory per session under the profiles dir", () => {
    expect(stealthProfileDir(profilesDir, "bot-a")).toBe(join(profilesDir, "bot-a"));
  });

  describe.skipIf(!existsSync(CHROME))("launched sessions", { timeout: 60_000 }, () => {
    it("refuses to prepare a page it cannot give the session's identity", async () => {
      const runtime = createStealthRuntime({ stateDir, profilesDir, debugPortBase: 19610, headed: false, solveCloudflare: false, chromeExecutable: CHROME });
      try {
        const context = await runtime.context("bot-a");
        const page = context.pages()[0] ?? await context.newPage();
        await expect(runtime.prepare("bot-a", page)).resolves.toBeUndefined();
        await expect(runtime.prepare("bot-never-launched", page)).rejects.toThrow(/identity/);
      } finally { await runtime.shutdown(); }
    });

    it("relaunches a session whose Chrome died instead of handing back its dead context", async () => {
      const runtime = createStealthRuntime({ stateDir, profilesDir, debugPortBase: 19620, headed: false, solveCloudflare: false, chromeExecutable: CHROME });
      try {
        const dead = await runtime.context("bot-a");
        const cdp = await dead.browser()!.newBrowserCDPSession();
        await cdp.send("Browser.close").catch(() => {});
        await expect.poll(async () => await runtime.context("bot-a") !== dead, { timeout: 30_000 }).toBe(true);
        const page = await (await runtime.context("bot-a")).newPage();
        expect(page.url()).toBe("about:blank");
      } finally { await runtime.shutdown(); }
    });
  });
});
