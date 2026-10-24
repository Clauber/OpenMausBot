// Real Apps → Access panel against a disposable fake-engine workspace, driven
// by headless Chromium through Playwright. Nothing here touches the user's
// app, data or credentials: the gog gateway is a local stub that refuses any
// key but a placeholder this script invents.
//
//   OMB_PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core \
//   OMB_CHROMIUM=/path/to/chrome \
//   node --experimental-strip-types scripts/verify-mcp-access.ts [evidence-dir]
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi, mountPreview, type MountedPreview } from "./testing/preview-fixture.ts";
import { startFakeHttpMcp } from "../server/testing/fake-http-mcp-server.ts";

const STUB_KEY = "stub-gateway-key-for-verification";
const FAKE_NOTES = fileURLToPath(new URL("../server/testing/fake-mcp-server.ts", import.meta.url));
const evidence = resolve(process.argv[2] ?? ".agents/screenshots");
mkdirSync(evidence, { recursive: true });

const { chromium } = createRequire(import.meta.url)(process.env.OMB_PLAYWRIGHT_CORE ?? "playwright-core") as typeof import("playwright-core");
const executablePath = process.env.OMB_CHROMIUM ?? "/home/clauber/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";

async function expectChecked(locator: import("playwright-core").Locator, checked: boolean) {
  await locator.waitFor();
  for (let i = 0; i < 100; i += 1) {
    if ((await locator.getAttribute("aria-checked")) === String(checked)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`switch never became ${checked}`);
}

const gateway = await startFakeHttpMcp({
  requireHeader: { name: "x-litellm-api-key", value: STUB_KEY },
  tools: [
    { name: "gmail_search", inputSchema: { type: "object" } },
    { name: "gmail_get_message", inputSchema: { type: "object" } },
    { name: "gmail_list_labels", inputSchema: { type: "object" } },
    { name: "calendar_events", inputSchema: { type: "object" } },
  ],
});
const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: "happy" });
let preview: MountedPreview | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  // The person's catalog file points gog at the stub; the key lives only in
  // the fixture home's env file, where the real server would look for it.
  writeFileSync(join(fixture.info.dataDir, "mcp-catalog.json"), JSON.stringify({ entries: [
    { name: "gog", label: "Gmail & Calendar", description: "Search and read Gmail, list Calendar events through the gog gateway.",
      transport: "http", url: gateway.url, headers: { "x-mcp-servers": "gog" },
      secrets: [{ target: "header", name: "x-litellm-api-key", envKey: "GOG_GATEWAY_KEY" }] },
    { name: "grafana", label: "Grafana", description: "Dashboards, Loki logs and Prometheus metrics.",
      transport: "http", url: gateway.url, headers: { "x-mcp-servers": "grafana" },
      secrets: [{ target: "header", name: "x-litellm-api-key", envKey: "GATEWAY_KEY_NOT_SET" }] },
  ] }));
  mkdirSync(join(fixture.info.dataDir, "ai"), { recursive: true });
  writeFileSync(join(fixture.info.dataDir, "ai", ".env"), `GOG_GATEWAY_KEY=${STUB_KEY}\n`);

  const api = fixtureApi(fixture.info.url, { headers: { origin: fixture.info.url } });
  const control = (args: string[]): Promise<any> => runControlOmb([...args, "--url", fixture.info.url]);
  await api("POST", "/api/mcp/servers/import", { json: JSON.stringify({ notes: { command: process.execPath, args: ["--experimental-strip-types", FAKE_NOTES] } }) });
  await api("POST", "/api/mcp/apps/notes/enable", {});
  const bots: Record<string, string> = {};
  for (const name of ["Mail tester", "Planner", "Scout"]) bots[name] = ((await control(["new-bot", "--name", name])) as { bot: { id: string } }).bot.id;
  await api("PATCH", "/api/config", { language: "en" }).catch(() => undefined);

  const pairing = await api("POST", "/api/auth/pairing", { scopes: ["admin", "client"] });
  preview = await mountPreview(fixture, { entry: "/scripts/testing/threads-preview.tsx", route: "/__threads.html", title: "Access fixture", logLevel: "error" });
  const userData = mkdtempSync(join(tmpdir(), "omb-access-browser-"));
  browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(preview.previewUrl);
  const paired = await page.evaluate(async (code) => (await fetch("/api/auth/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, cookie: true, label: "Access fixture" }) })).status, pairing.code);
  assert.equal(paired, 200);
  await page.reload();
  await page.waitForTimeout(1500);
  const shot = async (name: string) => { await page.screenshot({ path: join(evidence, name) }); console.log(`screenshot ${join(evidence, name)}`); };
  const toggle = (bot: string, app: string) => page.getByRole("switch", { name: `Let ${bot} use ${app}`, exact: true });
  const GOG = "Gmail & Calendar";
  const turn = async (botId: string) => {
    rmSync(fixture.fixtureDumpPath, { force: true });
    await control(["send", "--bot", botId, "--text", "Reply briefly."]);
    for (let i = 0; i < 100 && !existsSync(fixture.fixtureDumpPath); i += 1) await new Promise((r) => setTimeout(r, 150));
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as { mcpConfig: { mcpServers: Record<string, unknown> } };
    assert.equal((await control(["wait", "--bot", botId, "--timeout", "30"])).status, "settled");
    return Object.keys(dump.mcpConfig.mcpServers).filter((name) => ["notes", "gog", "grafana"].includes(name)).sort();
  };

  // Settings → Apps (the default view is Access).
  await page.getByText("You", { exact: true }).first().click();
  await page.getByText("Settings", { exact: true }).first().click();
  await page.getByRole("button", { name: "Apps", exact: true }).click();
  await page.locator("[data-grant-matrix]").waitFor();
  const filters = await page.locator("[data-apps-filter]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-apps-filter")));
  assert.deepEqual(filters, ["access", "mcp"], "Composio chips stay hidden without a key");
  const body = await page.evaluate(() => document.body.innerText);
  assert.ok(!body.includes("Connected apps are not set up yet"), "no Composio banner");
  assert.equal(await page.locator("[data-app-tile]").count(), 0, "no Composio cards");
  for (const row of ["notes", "gog", "grafana"]) assert.equal(await page.locator(`[data-grant-row="${row}"]`).count(), 1);
  await shot("01-access-matrix.png");
  await shot("07-no-composio.png");

  // A catalog app whose secret this machine does not have asks once, in the UI.
  await toggle("Planner", "Grafana").click();
  await page.locator('[data-access-secret-form="grafana"]').waitFor();
  await shot("08-secret-prompt.png");
  await page.getByRole("button", { name: "Cancel" }).click();
  assert.equal(await page.locator('[data-access-secret-form]').count(), 0);

  // Grant gog to one bot. It is not installed yet: the toggle installs it.
  assert.ok(!(await api("GET", "/api/mcp/servers")).servers.some((server: { name: string }) => server.name === "gog"));
  assert.deepEqual(await turn(bots["Mail tester"]!), ["notes"]);
  await toggle("Mail tester", GOG).click();
  await expectChecked(toggle("Mail tester", GOG), true);
  const installed = (await api("GET", "/api/mcp/servers")).servers.find((server: { name: string }) => server.name === "gog");
  assert.deepEqual(installed && { enabled: installed.enabled, url: installed.url, headerKeys: installed.headerKeys }, { enabled: true, url: gateway.url, headerKeys: ["x-litellm-api-key", "x-mcp-servers"] });
  await expectChecked(toggle("Planner", GOG), false);
  await expectChecked(toggle("Scout", GOG), false);
  await page.locator('[data-grant-row="gog"]').scrollIntoViewIfNeeded();
  await shot("02-gog-on.png");
  assert.deepEqual(await turn(bots["Mail tester"]!), ["gog", "notes"], "granted: mounted on the next turn");
  assert.deepEqual(await turn(bots.Planner!), ["notes"], "other bots stay as they were");

  // This bot's apps, and the tools they give it.
  await page.locator('[data-grant-view="bot"]').click();
  await page.selectOption("[data-grant-bot-select]", { label: "Mail tester" });
  await page.locator(`[data-grant-bot-view="${bots["Mail tester"]}"]`).waitFor();
  await shot("06-bot-apps.png");
  await page.locator("[data-grant-detail-button]").click();
  await page.locator('[data-grant-detail="gog"]').waitFor();
  const gogTools = await page.locator('[data-grant-detail="gog"] li').allInnerTexts();
  assert.deepEqual(gogTools.sort(), ["calendar_events", "gmail_get_message", "gmail_list_labels", "gmail_search"]);
  await shot("03-tools-with-gog.png");

  // Revoke: the switch goes off, the tools go with it, the app stays installed.
  await toggle("Mail tester", GOG).click();
  await expectChecked(toggle("Mail tester", GOG), false);
  await page.locator('[data-grant-detail="gog"]').waitFor({ state: "detached" });
  await page.locator('[data-grant-detail="notes"]').waitFor();
  assert.equal(await page.locator('[data-grant-detail="gog"]').count(), 0);
  await shot("05-tools-without-gog.png");
  await page.locator('[data-grant-view="row"]').click();
  await page.locator("[data-grant-matrix]").waitFor();
  await expectChecked(toggle("Mail tester", GOG), false);
  await page.locator('[data-grant-row="gog"]').scrollIntoViewIfNeeded();
  await shot("04-gog-off.png");
  assert.deepEqual(await turn(bots["Mail tester"]!), ["notes"], "revoked: gone on the next turn");
  assert.ok((await api("GET", "/api/mcp/servers")).servers.some((server: { name: string; enabled: boolean }) => server.name === "gog" && server.enabled), "the app stays installed");
  assert.ok(!JSON.stringify(await page.evaluate(() => document.body.innerHTML)).includes(STUB_KEY), "the key never reaches the page");
  console.log("access manager verified");
  rmSync(userData, { recursive: true, force: true });
} finally {
  await browser?.close();
  await preview?.close();
  await fixture.close();
  await gateway.close();
}
