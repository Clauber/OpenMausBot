import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentWrapperScript, writeAgentWrapper } from "./agent-wrapper.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zcode-wrapper-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// A stub bundle: `runtime/node` reports the HOME and arguments it was exec'd with.
function makeRoot(name = "root") {
  const root = join(dir, name);
  mkdirSync(join(root, "runtime"), { recursive: true });
  writeFileSync(join(root, "runtime", "node"), '#!/bin/sh\nprintf "%s\\n%s\\n%s\\n" "$HOME" "$1" "$*"\n', { mode: 0o755 });
  writeFileSync(join(root, "runtime", "zcode.cjs"), "");
  return root;
}

function runWrapper(script: string, identity: string | undefined, args: string[] = ["app-server", "--stdio"]) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/original/home" };
  if (identity !== undefined) env.ZCODE_WORKSPACE_IDENTITY = identity;
  return spawnSync(script, args, { env, encoding: "utf8" });
}

describe("agent wrapper", () => {
  it("sets HOME from the workspace identity, creates it, and execs the bundled node with the arguments", async () => {
    const root = makeRoot();
    const botHomesRoot = join(dir, "bot-homes");
    const script = await writeAgentWrapper({ dataDir: join(dir, "data"), root, botHomesRoot });
    const result = runWrapper(script, "bot_1-A");
    expect(result.status).toBe(0);
    const [home, entry, argv] = result.stdout.split("\n");
    expect(home).toBe(join(botHomesRoot, "bot_1-A", "home"));
    expect(entry).toBe(join(root, "runtime", "zcode.cjs"));
    expect(argv).toBe(`${join(root, "runtime", "zcode.cjs")} app-server --stdio`);
    expect(statSync(home!).isDirectory()).toBe(true);
  });

  it("accepts a 128 character identity", async () => {
    const script = await writeAgentWrapper({ dataDir: dir, root: makeRoot(), botHomesRoot: join(dir, "homes") });
    expect(runWrapper(script, "a".repeat(128)).status).toBe(0);
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["parent segment", ".."],
    ["path traversal", "../escape"],
    ["slash", "a/b"],
    ["space", "a b"],
    ["shell metacharacters", "a;touch pwned"],
    ["newline", "a\nb"],
    ["non ASCII", "café"],
    ["129 characters", "a".repeat(129)],
  ])("exits 64 without starting the agent for an identity that is %s", async (_name, identity) => {
    const botHomesRoot = join(dir, "homes");
    const script = await writeAgentWrapper({ dataDir: dir, root: makeRoot(), botHomesRoot });
    const result = runWrapper(script, identity);
    expect(result.status).toBe(64);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(existsSync(botHomesRoot)).toBe(false);
  });

  it("quotes paths with spaces and apostrophes", async () => {
    const root = makeRoot("it's a root");
    const botHomesRoot = join(dir, "bot homes $HOME");
    const script = await writeAgentWrapper({ dataDir: dir, root, botHomesRoot });
    const result = runWrapper(script, "bot");
    expect(result.status).toBe(0);
    expect(result.stdout.split("\n")[0]).toBe(join(botHomesRoot, "bot", "home"));
  });

  it("writes an executable script into the data dir and replaces it on rewrite", async () => {
    const dataDir = join(dir, "data");
    const first = await writeAgentWrapper({ dataDir, root: makeRoot("a"), botHomesRoot: join(dir, "homes") });
    expect(first.startsWith(dataDir)).toBe(true);
    expect(statSync(first).mode & 0o777).toBe(0o755);
    const second = await writeAgentWrapper({ dataDir, root: makeRoot("b"), botHomesRoot: join(dir, "homes") });
    expect(second).toBe(first);
    expect(runWrapper(second, "bot").stdout.split("\n")[1]).toBe(join(dir, "b", "runtime", "zcode.cjs"));
  });

  it("never echoes the environment", () => {
    const script = agentWrapperScript({ root: "/r", botHomesRoot: "/h" });
    expect(script).not.toMatch(/\b(env|printenv|echo|printf|set)\b/);
  });
});
