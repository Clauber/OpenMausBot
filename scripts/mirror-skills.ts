#!/usr/bin/env -S node --experimental-strip-types
// Pull a skill library into Legion's skill-source mirror. Pull-only: the
// source is read (over rsync/ssh when it is host:/path, straight from disk
// otherwise) and never written. Credential-looking files, dot folders, links
// and oversized files stay behind. Then import from Settings → Skills.
//
//   node --experimental-strip-types scripts/mirror-skills.ts <id> <source> [data-dir]
//   node --experimental-strip-types scripts/mirror-skills.ts hermes luna:/home/shado/.hermes/skills
//   node --experimental-strip-types scripts/mirror-skills.ts shared /workspace/ai/skills
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { mirrorSkillTree } from "../server/skill-sources.ts";

const [id, source, dataArg] = process.argv.slice(2);
if (!id || !source || !/^[a-z][a-z0-9-]{0,31}$/.test(id)) {
  console.error("usage: mirror-skills.ts <id> <source: /path or host:/path> [data-dir]");
  process.exit(2);
}
const dataDir = dataArg ?? process.env.OMB_DATA_DIR ?? join(homedir(), ".openmausbot");
const mirror = join(dataDir, "skill-sources", id);

let from = source;
let staging: string | undefined;
if (/^[A-Za-z0-9._-]+:\//.test(source)) {
  // Remote: rsync PULLS into a private staging folder (the only direction
  // rsync is given), then the mirror applies its own filters to that copy.
  staging = mkdtempSync(join(tmpdir(), "omb-skill-pull-"));
  execFileSync("rsync", [
    "-a", "--safe-links", "--max-size=2m", "--exclude=.git", "--exclude=node_modules",
    "-e", "ssh -o BatchMode=yes", `${source.replace(/\/?$/, "/")}`, `${staging}/`,
  ], { stdio: "inherit" });
  from = staging;
}
try {
  const result = mirrorSkillTree(from, mirror);
  console.log(`mirrored ${result.copied} files into ${mirror} (removed ${result.removed})`);
  for (const entry of result.excluded) console.log(`left behind ${entry.path}: ${entry.reason}`);
} finally {
  if (staging) rmSync(staging, { recursive: true, force: true });
}
