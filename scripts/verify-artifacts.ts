// Versioned thread artifacts against a real harness (fake engine) in a
// throwaway data directory. The bot's files are written into its workspace by
// this script (standing in for the engine) and handed over through the real
// attach_file harness route with the bot's turn capability. Run directly:
//   node --experimental-strip-types scripts/verify-artifacts.ts
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { startHeldFixture } from "./verify-web-tools.ts";

export async function verifyArtifacts() {
  const held = await startHeldFixture();
  const { api, bot, token, url } = held;
  const say = (line: string) => process.stdout.write(`${line}\n`);
  try {
    const workspace = join(held.fixture.info.dataDir, "workspaces", bot.id);
    mkdirSync(workspace, { recursive: true });
    const attach = (path: string) => api("POST", "/api/internal/attach-file", { path }, 200, token);

    writeFileSync(join(workspace, "report.csv"), "quarter,total\nQ1,10\n");
    writeFileSync(join(workspace, "notes.txt"), "plain notes\n");
    await attach("report.csv");
    await attach("notes.txt");
    writeFileSync(join(workspace, "report.csv"), "quarter,total\nQ1,10\nQ2,25\n");
    await attach("report.csv");

    // (e) two artifacts, one with v1 + v2
    const list = (await api("GET", `/api/threads/${bot.threadId}/artifacts`)).artifacts as Array<{ id: string; name: string; version: number; size: number; url: string }>;
    assert.equal(list.length, 2, JSON.stringify(list));
    const report = list.find((a) => a.name === "report.csv")!;
    const notes = list.find((a) => a.name === "notes.txt")!;
    assert.equal(report.version, 2);
    assert.equal(notes.version, 1);
    const versions = (await api("GET", `/api/artifacts/${report.id}/versions`)).versions as Array<{ id: string; version: number }>;
    assert.deepEqual(versions.map((v) => v.version), [1, 2]);
    const download = async (id: string) => {
      const res = await fetch(`${url}/api/artifacts/${id}`, { headers: { origin: url } });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-disposition") ?? "", /attachment/);
      return Buffer.from(await res.arrayBuffer()).toString();
    };
    assert.equal(await download(versions[0]!.id), "quarter,total\nQ1,10\n");
    assert.equal(await download(versions[1]!.id), "quarter,total\nQ1,10\nQ2,25\n");
    assert.equal(await download(notes.id), "plain notes\n");
    say(`(e) PASS 2 artifacts: report.csv v${versions.map((v) => v.version).join("+v")} (v1 and v2 download their own bytes), notes.txt v1`);

    // scoped to the thread
    const other = (await api("POST", "/api/bots", { name: "Other bot" }, 201)).bot;
    const otherList = (await api("GET", `/api/threads/${other.threadId}/artifacts`)).artifacts;
    assert.deepEqual(otherList, []);
    await api("GET", "/api/threads/00000000-0000-0000-0000-000000000000/artifacts", undefined, 404);
    await api("GET", "/api/artifacts/not-a-real-id", undefined, 404);
    say("    PASS another bot's thread lists 0 artifacts; unknown thread and artifact ids are 404");
  } finally {
    await held.fixture.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await verifyArtifacts();
