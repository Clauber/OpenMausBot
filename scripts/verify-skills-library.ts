// Settings → Skills against a disposable fake-engine workspace, driven by
// headless Chromium through Playwright: the real Hermes and shared skill
// folders are mirrored (pull-only) into the fixture's own data directory,
// imported through the UI, approved, and assigned per bot, and the bot's next
// turn is read back from the fake engine's dump.
//
//   OMB_PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core \
//   OMB_CHROMIUM=/path/to/chrome \
//   node --experimental-strip-types scripts/verify-skills-library.ts [evidence-dir]
//
// OMB_SKILL_SOURCE_HERMES (default luna:/home/shado/.hermes/skills) and
// OMB_SKILL_SOURCE_SHARED (default /workspace/ai/skills) name the sources.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi, mountPreview, type MountedPreview } from "./testing/preview-fixture.ts";

const evidence = resolve(process.argv[2] ?? ".agents/screenshots");
mkdirSync(evidence, { recursive: true });
const { chromium } = createRequire(import.meta.url)(process.env.OMB_PLAYWRIGHT_CORE ?? "playwright-core") as typeof import("playwright-core");
const executablePath = process.env.OMB_CHROMIUM ?? "/home/clauber/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";
const mirrorScript = fileURLToPath(new URL("./mirror-skills.ts", import.meta.url));

const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: "happy" });
let preview: MountedPreview | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const api = fixtureApi(fixture.info.url, { headers: { origin: fixture.info.url } });
  const control = (args: string[]): Promise<any> => runControlOmb([...args, "--url", fixture.info.url]);
  await api("PATCH", "/api/config", { features: { skillsLibrary: true } });
  for (const [id, from] of [
    ["hermes", process.env.OMB_SKILL_SOURCE_HERMES ?? "luna:/home/shado/.hermes/skills"],
    ["shared", process.env.OMB_SKILL_SOURCE_SHARED ?? "/workspace/ai/skills"],
  ] as const) {
    console.log(execFileSync(process.execPath, ["--experimental-strip-types", mirrorScript, id, from, fixture.info.dataDir], { encoding: "utf8" }).split("\n").slice(0, 1).join(""));
  }
  const bots: Record<string, string> = {};
  for (const name of ["Skill tester", "Planner", "Scout"]) bots[name] = ((await control(["new-bot", "--name", name])) as { bot: { id: string } }).bot.id;
  const catalog = await api("GET", "/api/skill-sources");
  const fresh = (source: string) => catalog.skills.filter((skill: any) => skill.source === source && !skill.error && !skill.duplicateOf && !skill.lunaDependent.length && !skill.secretLiterals.length);
  const luna = catalog.skills.find((skill: any) => skill.lunaDependent.length && !skill.duplicateOf && !skill.secretLiterals.length);
  const sharedPick = fresh("shared")[0].name as string;
  const hermesPick = fresh("hermes")[0].name as string;
  console.log(JSON.stringify({ sources: catalog.sources, sharedPick, hermesPick, lunaPick: luna.name }));

  const turnPrompt = async (botId: string) => {
    rmSync(fixture.fixtureDumpPath, { force: true });
    await control(["send", "--bot", botId, "--text", "Reply briefly."]);
    for (let i = 0; i < 100 && !existsSync(fixture.fixtureDumpPath); i += 1) await new Promise((r) => setTimeout(r, 150));
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as { systemPrompt: string | null };
    assert.equal((await control(["wait", "--bot", botId, "--timeout", "30"])).status, "settled");
    return dump.systemPrompt ?? "";
  };
  const skillLines = (prompt: string) => prompt.split("\n").filter((line) => line.startsWith("- ") && line.includes(" Read \"")).map((line) => line.replace(/ Read ".*$/, ""));

  const pairing = await api("POST", "/api/auth/pairing", { scopes: ["admin", "client"] });
  preview = await mountPreview(fixture, { entry: "/scripts/testing/threads-preview.tsx", route: "/__threads.html", title: "Skills fixture", logLevel: "error" });
  browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await page.goto(preview.previewUrl);
  assert.equal(await page.evaluate(async (code) => (await fetch("/api/auth/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, cookie: true, label: "Skills fixture" }) })).status, pairing.code), 200);
  await page.reload();
  await page.waitForTimeout(1500);
  const shot = async (name: string) => { await page.screenshot({ path: join(evidence, name) }); console.log(`screenshot ${join(evidence, name)}`); };
  const toggleCell = (bot: string, skill: string) => page.getByRole("switch", { name: `Give ${bot} the skill ${skill}`, exact: true });
  const checked = async (locator: ReturnType<typeof toggleCell>, want: boolean) => {
    for (let i = 0; i < 100; i += 1) { if ((await locator.getAttribute("aria-checked")) === String(want)) return; await page.waitForTimeout(100); }
    assert.fail(`switch never became ${want}`);
  };

  // Settings → Skills → Library: both sources, with the held (flagged) skills.
  await page.getByText("You", { exact: true }).first().click();
  await page.getByText("Settings", { exact: true }).first().click();
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  await page.locator("[data-skill-sources]").waitFor();
  await page.locator('[data-skill-source="hermes"]').waitFor();
  await page.locator('[data-skill-source="shared"]').waitFor();
  assert.ok((await page.locator("[data-skill-held-row]").count()) > 0, "flagged skills are held back");
  await page.locator("[data-skill-sources]").scrollIntoViewIfNeeded();
  await shot("01-skills-sources.png");

  // Import every clean skill through the UI; the flagged ones stay listed.
  await page.locator("[data-skill-import-all]").click();
  await page.waitForFunction(() => document.body.innerText.includes("Left "));
  const library1 = (await api("GET", "/api/skills-library")).skills as Array<{ name: string; enabled: boolean; source: string }>;
  assert.ok(library1.length > 20 && library1.every((skill) => !skill.enabled), "imports land unapproved");
  assert.ok(!library1.some((skill) => skill.name === luna.name), "a Luna-dependent skill is not in the bulk import");
  await page.locator(`[data-skill-held-row="${luna.name}"]`).getByRole("button", { name: "Import anyway" }).click();
  await page.waitForFunction((name) => !document.querySelector(`[data-skill-held-row="${name}"]`), luna.name);
  const lunaEntry = ((await api("GET", "/api/skills-library")).skills as any[]).find((skill) => skill.name === luna.name);
  assert.ok(lunaEntry.tags.includes("luna-only") && lunaEntry.warnings.some((w: string) => w.startsWith("Needs Hermes or Luna")));
  await page.locator('[data-grant-badge="Needs Hermes or Luna"]').first().scrollIntoViewIfNeeded();
  await shot("02-skills-library-badges.png");

  // Review and approve two skills (one per source) so they can be assigned.
  for (const name of [sharedPick, hermesPick]) {
    await page.getByRole("switch", { name: `Enable ${name}`, exact: true }).scrollIntoViewIfNeeded();
    await page.getByRole("switch", { name: `Enable ${name}`, exact: true }).click();
    await page.getByRole("button", { name: "Enable reviewed skill" }).click();
    await page.getByRole("switch", { name: `Disable ${name}`, exact: true }).waitFor();
  }

  // Assign tab: the grid.
  await page.locator('[data-skills-tab="assign"]').click();
  await page.locator("[data-grant-matrix]").waitFor();
  await page.locator(`[data-grant-row="${sharedPick}"]`).scrollIntoViewIfNeeded();
  assert.equal(await page.locator(`[data-grant-cell="${luna.name}:${bots["Skill tester"]}"]`).isDisabled(), true, "an unapproved skill cannot be assigned");
  await shot("03-assign-grid.png");
  assert.deepEqual(skillLines(await turnPrompt(bots["Skill tester"]!)).filter((line) => line.startsWith(`- ${sharedPick}:`)), []);
  await toggleCell("Skill tester", sharedPick).click();
  await checked(toggleCell("Skill tester", sharedPick), true);
  await page.locator(`[data-grant-row="${sharedPick}"]`).scrollIntoViewIfNeeded();
  await shot("04-assign-toggled.png");
  const withSkill = await turnPrompt(bots["Skill tester"]!);
  assert.equal(skillLines(withSkill).filter((line) => line.startsWith(`- ${sharedPick}:`)).length, 1, "assigned: in the next turn's skills index");
  assert.equal(skillLines(await turnPrompt(bots.Planner!)).filter((line) => line.startsWith(`- ${sharedPick}:`)).length, 0, "other bots do not get it");

  // This bot's skills.
  await toggleCell("Skill tester", hermesPick).click();
  await checked(toggleCell("Skill tester", hermesPick), true);
  await page.locator('[data-grant-view="bot"]').click();
  await page.selectOption("[data-grant-bot-select]", { label: "Skill tester" });
  await page.locator(`[data-grant-bot-view="${bots["Skill tester"]}"]`).waitFor();
  assert.ok(await page.locator(`[data-grant-bot-row="${hermesPick}"]`).isVisible());
  await shot("05-bot-skills.png");

  // Revoke one: gone on the next turn, the other stays.
  await toggleCell("Skill tester", sharedPick).click();
  await checked(toggleCell("Skill tester", sharedPick), false);
  await shot("06-bot-skills-after-revoke.png");
  const after = skillLines(await turnPrompt(bots["Skill tester"]!));
  assert.equal(after.filter((line) => line.startsWith(`- ${sharedPick}:`)).length, 0, "revoked: gone from the next turn");
  assert.equal(after.filter((line) => line.startsWith(`- ${hermesPick}:`)).length, 1, "the other assignment stays");

  // Evidence for the next-turn effect, rendered from the captured prompts.
  writeFileSync(join(evidence, "skills-next-turn.json"), JSON.stringify({ sharedPick, hermesPick, beforeAssign: "no matching line", afterAssign: skillLines(withSkill).filter((line) => line.startsWith("- ")).map((line) => line.slice(0, 120)), afterRevoke: after.map((line) => line.slice(0, 120)) }, null, 2));
  const proof = await (await browser.newContext({ viewport: { width: 1100, height: 520 } })).newPage();
  const esc = (text: string) => text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  await proof.setContent(`<body style="font:13px ui-monospace,monospace;background:#161616;color:#e6e6e6;padding:24px"><h3 style="font:600 15px system-ui">Skill tester: "Imported skills" index in the system prompt of its next turn</h3><p style="color:#9a9a9a;font:13px system-ui">Captured from the fake engine's dump. Assigned: ${esc(sharedPick)}. Revoked after: ${esc(sharedPick)} (${esc(hermesPick)} kept).</p><h4 style="font:600 13px system-ui">After assigning ${esc(sharedPick)}</h4><pre style="white-space:pre-wrap">${esc(skillLines(withSkill).map((l) => l.slice(0, 150)).join("\n"))}</pre><h4 style="font:600 13px system-ui">After revoking ${esc(sharedPick)} (and assigning ${esc(hermesPick)})</h4><pre style="white-space:pre-wrap">${esc(after.map((l) => l.slice(0, 150)).join("\n"))}</pre></body>`);
  await proof.screenshot({ path: join(evidence, "07-next-turn-proof.png") });
  console.log(`screenshot ${join(evidence, "07-next-turn-proof.png")}`);
  console.log("skills library verified");
} finally {
  await browser?.close();
  await preview?.close();
  await fixture.close();
}
