import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { launchVerificationServer } from "./control-omb.ts";
import { startFakeTaughtComputer } from "../server/testing/fake-taught-computer.ts";
import { mountPreview, type MountedPreview } from "./testing/preview-fixture.ts";

export async function verifyTaughtSkills(ui = false) {
  const computer = await startFakeTaughtComputer();
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, [], undefined, computer.url).catch(async error => { await computer.close(); throw error; });
  const evidence: unknown[] = [];
  let preview: MountedPreview | undefined;
  const evidenceDir = join(process.cwd(), ".omb-scratch", "verify-evidence", "taught-skills");
  mkdirSync(evidenceDir, { recursive: true });
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any;
    evidence.push({ method, path, status: response.status, result });
    assert.equal(response.status, status, JSON.stringify(result)); return result;
  };
  const wait = async (read: () => Promise<any>) => {
    const start = Date.now();
    while (Date.now() - start < 15_000) { const result = await read(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error("Fixture state did not settle.");
  };
  try {
    const bot = (await api("POST", "/api/bots", { name: "Teaching fixture", computer: "vm" }, 201)).bot;
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "vm" });
    await api("PATCH", "/api/config", { features: { skillsLibrary: true } });
    const base = `/api/bots/${bot.id}/tasks/${bot.threadId}/teach`;
    await api("POST", `${base}/start`, { title: "Fill the demo form", notes: "Navigate, choose the name field, enter Demo." }, 201);
    for (const [tool, args] of [["navigate", { url: "https://example.com/demo" }], ["click", { selector: "#name" }], ["type", { text: "Demo" }]] as const)
      await api("POST", `${base}/action`, { tool, args });
    const book = (await api("POST", `${base}/stop`, {}, 201)).playbook;
    const directory = join(fixture.info.dataDir, "skills-library", "skills", book.name);
    const saved = JSON.parse(readFileSync(join(directory, "playbook.json"), "utf8"));
    assert.equal(saved.steps.length, 3); assert.deepEqual(saved.steps.map((step: any) => step.action), ["navigate", "click", "type"]);
    assert.ok(saved.steps.every((step: any) => step.screenshots.length === 1));
    assert.ok(readFileSync(join(directory, "SKILL.md"), "utf8").includes("Playbook SHA-256"));
    console.log("(a) recorded 3 ordered events, screenshot references and SKILL.md in the skill library");
    const requested = await api("POST", `${base}/replay`, { name: book.name }, 202);
    assert.equal(requested.run.status, "awaiting-approval"); assert.equal(computer.calls.length, 3);
    const transcript = (await api("GET", `/api/threads/${bot.threadId}/messages`)).messages;
    const card = transcript.find((message: any) => message.card?.requestId === requested.requestId).card;
    assert.ok(card.skillRequest.preview.includes('"navigate"')); assert.deepEqual(card.options, ["Enable", "Deny"]);
    // The ordinary lifecycle rejects approval without the reviewed hash.
    await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: card.requestId, behavior: "allow" }, 409);
    await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: card.requestId, behavior: "allow", reviewedSha256: card.skillRequest.sha256 });
    const success = await wait(async () => (await api("GET", base)).playbooks[0].runs.find((run: any) => run.id === requested.run.id && run.status === "success"));
    assert.equal(success.completedSteps, 3); assert.deepEqual(computer.calls.slice(3).map((call: any) => call.name), ["navigate", "click", "type"]);
    console.log("(b) standard approval card, hash-gated approval, ordered MCP replay and successful run history");
    computer.failClick(true);
    const before = computer.calls.length;
    const failedRequest = await api("POST", `${base}/replay`, { name: book.name }, 202);
    assert.equal(failedRequest.requestId, undefined);
    const failed = await wait(async () => (await api("GET", base)).playbooks[0].runs.find((run: any) => run.id === failedRequest.run.id && run.status === "failed"));
    assert.equal(failed.failedStep, 1); assert.equal(failed.completedSteps, 1);
    assert.deepEqual(computer.calls.slice(before).map((call: any) => call.name), ["navigate", "click"]);
    console.log("(c) element-not-found stops at index 1; no type step executed");
    computer.failClick(false);
    const next = await api("POST", `${base}/replay`, { name: book.name }, 202);
    assert.equal(next.requestId, undefined);
    await wait(async () => (await api("GET", base)).playbooks[0].runs.find((run: any) => run.id === next.run.id && run.status === "success"));
    const cardsAfter = (await api("GET", `/api/threads/${bot.threadId}/messages`)).messages.filter((message: any) => message.card?.skillRequest);
    assert.equal(cardsAfter.length, 1);
    console.log("(d) lifecycle-approved playbook replays successfully without another card");
    // Always-ask, denial, per-bot scope, unsupported tools and screenshot stop.
    await api("POST", `${base}/settings`, { alwaysAsk: true });
    const again = await api("POST", `${base}/replay`, { name: book.name }, 202);
    assert.equal(again.run.status, "awaiting-approval");
    await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: again.requestId, behavior: "deny" });
    assert.ok((await api("GET", base)).playbooks[0].runs.some((run: any) => run.id === again.run.id && run.status === "rejected"));
    await api("POST", `${base}/settings`, { alwaysAsk: false });
    computer.differentScreenshot(true);
    const comparison = await api("POST", `${base}/replay`, { name: book.name, compareScreenshots: true }, 202);
    const mismatch = await wait(async () => (await api("GET", base)).playbooks[0].runs.find((run: any) => run.id === comparison.run.id && run.status === "failed"));
    assert.equal(mismatch.failedStep, 0); assert.match(mismatch.error, /Screenshot mismatch/); computer.differentScreenshot(false);
    await api("POST", `${base}/start`, { title: "Discarded demonstration" }, 201);
    const beforeDanger = computer.calls.length;
    await api("POST", `${base}/action`, { tool: "exec", args: { command: "echo unsafe" } }, 409);
    assert.equal(computer.calls.length, beforeDanger); await api("POST", `${base}/discard`, {});
    const other = (await api("POST", "/api/bots", { name: "Other teaching fixture", computer: "vm" }, 201)).bot;
    await api("PATCH", `/api/bots/${other.id}`, { computer: "vm" });
    const otherBase = `/api/bots/${other.id}/tasks/${other.threadId}/teach`;
    const scoped = await api("POST", `${otherBase}/replay`, { name: book.name }, 202);
    assert.equal(scoped.run.status, "awaiting-approval");
    await api("POST", `/api/threads/${other.threadId}/respond`, { requestId: scoped.requestId, behavior: "deny" });
    if (ui) {
      preview = await mountPreview(fixture, { entry: "/scripts/testing/taught-skills-preview.tsx", route: "/taught", title: "Taught skills fixture" });
      const { verifyTaughtSkillsUi } = await import("./testing/taught-skills-ui.ts");
      evidence.push(await verifyTaughtSkillsUi(`${preview.previewUrl}?bot=${bot.id}`, evidenceDir, computer.failClick));
    }
    writeFileSync(join(evidenceDir, "evidence.json"), JSON.stringify({ fixture: fixture.info, gates: { a: true, b: true, c: true, d: true }, requests: evidence, mcpCalls: computer.calls }, null, 2));
    console.log(JSON.stringify({ ...fixture.info, evidencePath: join(evidenceDir, "evidence.json") }));
    return { a: true, b: true, c: true, d: true };
  } finally { await preview?.close(); await fixture.close(); await computer.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await verifyTaughtSkills(process.argv.includes("--ui"));
}
