import { spawn } from "node:child_process";
import { stripWorkspaceCredentialEnv } from "./credential-env.ts";

export async function hostExec({ cwd, command, timeoutSeconds = 60, signal }: {
  cwd: string; command: string; timeoutSeconds?: number; signal?: AbortSignal;
}) {
  if (!command.trim() || command.length > 64 * 1024) throw new Error("A non-empty command of at most 65536 characters is required.");
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300) throw new Error("The timeout must be an integer between 1 and 300 seconds.");
  signal?.throwIfAborted();
  const env = { ...process.env };
  stripWorkspaceCredentialEnv(env);
  return new Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean; truncated: boolean }>((resolve, reject) => {
    const child = spawn(process.platform === "win32" ? "sh" : "/bin/sh", ["-lc", command], { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let remaining = 64 * 1024, timedOut = false, truncated = false;
    const capture = (chunks: Buffer[], chunk: Buffer) => {
      if (remaining) chunks.push(chunk.subarray(0, remaining));
      if (chunk.length > remaining) truncated = true;
      remaining = Math.max(0, remaining - chunk.length);
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    const stop = () => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        killer.on("error", () => child.kill("SIGKILL"));
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutSeconds * 1000);
    signal?.addEventListener("abort", stop, { once: true });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", stop); };
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", code => {
      cleanup();
      if (signal?.aborted) { reject(signal.reason); return; }
      resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exitCode: code ?? 1, timedOut, truncated });
    });
  });
}
