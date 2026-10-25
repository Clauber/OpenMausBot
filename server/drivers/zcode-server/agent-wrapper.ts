// The ZCode server spawns one agent per workspace identity with the server's own environment, so a per-bot HOME has to be
// applied by the agent command itself. The identity becomes a path segment: only a plain token is accepted, anything else exits 64 (EX_USAGE).
// The character class lists its members instead of using ranges, so a locale's collation order cannot widen it.
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export function agentWrapperScript(options: { root: string; botHomesRoot: string }): string {
  return `#!/bin/sh
id=\${ZCODE_WORKSPACE_IDENTITY-}
case $id in
  ''|*[!ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-]*) exit 64 ;;
esac
[ \${#id} -le 128 ] || exit 64
HOME=${shellQuote(options.botHomesRoot)}/$id/home
mkdir -p "$HOME" || exit 73
export HOME
exec ${shellQuote(join(options.root, "runtime", "node"))} ${shellQuote(join(options.root, "runtime", "zcode.cjs"))} "$@"
`;
}

/** Rewritten on every server start; the rename keeps a running server's next agent spawn from reading a half-written script. */
export async function writeAgentWrapper(options: { dataDir: string; root: string; botHomesRoot: string }): Promise<string> {
  const path = join(options.dataDir, "legion-agent.sh");
  const temp = `${path}.${process.pid}.tmp`;
  await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
  await writeFile(temp, agentWrapperScript(options), { mode: 0o755 });
  await chmod(temp, 0o755);
  await rename(temp, path);
  return path;
}
