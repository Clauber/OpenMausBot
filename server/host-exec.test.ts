import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostExec } from "./host-exec.ts";

describe("hostExec", () => {
  it("runs a login shell in the task workspace and returns both streams and exit code", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "legion-host-exec-"));
    try {
      const result = await hostExec({ cwd, command: "pwd; printf error >&2; exit 7" });
      expect(result).toMatchObject({ stdout: `${cwd}\n`, stderr: "error", exitCode: 7, timedOut: false });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  it("bounds output and stops the process group at the deadline", async () => {
    const result = await hostExec({ cwd: tmpdir(), command: "yes output", timeoutSeconds: 1 });
    expect(result.timedOut).toBe(true);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(64 * 1024);
  });
  it("rejects empty commands and invalid timeouts", async () => {
    await expect(hostExec({ cwd: tmpdir(), command: " " })).rejects.toThrow("command");
    await expect(hostExec({ cwd: tmpdir(), command: "true", timeoutSeconds: 301 })).rejects.toThrow("timeout");
  });
});
