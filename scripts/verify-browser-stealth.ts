// The built-in stealth browser fixture: a fingerprinted Chrome per session.
//
// Starts a disposable fixture server with the built-in stealth browser
// enabled (browserEngine.stealth), has the fake engine drive a real bot turn
// through the agent_browser tools against a loopback test page, and proves
// from the page itself that the browser the bot drove reports the session's
// fingerprint identity — never this Linux host's plain Chrome.
//
//   OMB_VERIFY_BROWSER_BINARY=<agent-browser> OMB_VERIFY_BROWSER_CHROME=<chrome> \
//     node --experimental-strip-types scripts/verify-browser-stealth.ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { launchVerificationServer } from "./control-omb.ts";

const binaryPath = process.env.OMB_VERIFY_BROWSER_BINARY;
const executablePath = process.env.OMB_VERIFY_BROWSER_CHROME;
if (!binaryPath || !executablePath) throw new Error("Set OMB_VERIFY_BROWSER_BINARY and OMB_VERIFY_BROWSER_CHROME to explicit installed binaries.");

// The test page is served before the fixture exists so its URL can be baked
// into the fake engine's scripted tool calls. Loopback only. The page reports
// exactly the identity a site would fingerprint.
const testPageServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.url !== "/__stealth-page") {
    res.writeHead(404).end();
    return;
  }
  res.setHeader("content-type", "text/html");
  res.end(`<!doctype html><html><body><pre id="ua"></pre><script>
document.getElementById("ua").textContent = [
  navigator.userAgent,
  "platform=" + navigator.platform,
  "languages=" + navigator.languages.join(","),
  "chrome=" + String(Boolean(window.chrome)),
].join(" | ");
</script></body></html>`);
});
const testPagePort = await new Promise<number>((resolve) => {
  testPageServer.listen({ port: 0, host: "127.0.0.1" }, () => resolve((testPageServer.address() as { port: number }).port));
});
const testPageUrl = `http://127.0.0.1:${testPagePort}/__stealth-page`;

const fail = (message: string): never => { throw new Error(message); };

// One scripted turn: open the page, hold it open long enough to inspect from
// outside, then read it back. The launcher snapshots this environment at
// launch, so the tool calls go in before the fixture starts.
process.env.FAKE_CLAUDE_TOOL_CALLS = JSON.stringify([
  { name: "agent_browser_open", input: { url: testPageUrl } },
  { name: "agent_browser_wait_ms", input: { ms: 20_000 } },
  { name: "agent_browser_get_text", input: { selector: "#ua" } },
]);

const fixture = await launchVerificationServer(process.env, undefined, undefined, { binaryPath, executablePath });
const url = fixture.info.url;
const api = async (path: string, method: string, body?: unknown) => {
  const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = await response.json().catch(() => null);
  return { status: response.status, json };
};

try {
  // Stealth on, at a port base far from any live stealth service on this host.
  const config = await api("/api/config", "PATCH", { features: { browser: true }, browserEngine: { stealth: { enabled: true, debugPortBase: 19700 } } });
  if (config.status !== 200) fail(`config patch failed: ${config.status} ${JSON.stringify(config.json)}`);

  const created = await api("/api/bots", "POST", { name: "Pepper" });
  const botId = (created.json as { bot?: { id: string } })?.bot?.id ?? fail(`bot create failed: ${JSON.stringify(created.json)}`);
  const patched = await api(`/api/bots/${botId}`, "PATCH", { browser: true });
  if (patched.status !== 200) fail(`browser enable failed: ${patched.status}`);

  const fleetBefore = await api("/api/bots?messages=0");
  const threadId = (fleetBefore.json as { bots: Array<{ id: string; threadId: string }> }).bots.find((bot) => bot.id === botId)?.threadId
    ?? fail("new bot has no thread");
  const sent = await api(`/api/bots/${botId}/messages`, "POST", { text: "open the test page and read the user agent", threadId });
  if (sent.status !== 200 && sent.status !== 202) fail(`send failed: ${sent.status} ${JSON.stringify(sent.json)}`);

  // The stealth context launches at the turn's first browser mount; its port
  // record appears within seconds of the send.
  const stateDir = join(fixture.info.dataDir, "stealth-browser", "state");
  for (let i = 0; i < 20 && !existsSync(join(stateDir, "debug-ports.json")); i++) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!existsSync(join(stateDir, "debug-ports.json"))) {
    const logTail = readFileSync(fixture.info.logPath, "utf-8").split("\n").slice(-25).join("\n");
    fail(`the stealth browser never launched.\nserver log tail:\n${logTail}`);
  }
  const portRecord = JSON.parse(readFileSync(join(stateDir, "debug-ports.json"), "utf-8")) as Record<string, number>;
  const sessionPort = Object.values(portRecord)[0];

  // The page the bot opened must be a live target in the stealth context
  // itself — if agent-browser drove any other Chrome, the page would never
  // appear here. It stays open for the scripted wait; read its identity the
  // moment it is up, through the same CDP endpoint.
  const { chromium } = await import("patchright");
  const fpName = readdirSync(stateDir).find((name) => name.endsWith("-fingerprint.json"))
    ?? fail("the stealth browser persisted no session fingerprint");
  const fingerprint = JSON.parse(readFileSync(join(stateDir, fpName), "utf-8")) as { fingerprint: { navigator: { userAgent: string } } };
  const want = fingerprint.fingerprint.navigator.userAgent;

  let identity: string | null = null;
  let transcript = "";
  const deadline = Date.now() + 120_000;
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  while (Date.now() < deadline && identity === null) {
    let targets: Array<{ url: string }> = [];
    try { targets = await (await fetch(`http://127.0.0.1:${sessionPort}/json/list`)).json(); } catch { await sleep(300); continue; }
    if (!targets.some((target) => target.type === "page" && target.url.includes("stealth-page"))) {
      transcript = JSON.stringify((await api(`/api/threads/${threadId}/messages?limit=50`)).json);
      await sleep(300);
      continue;
    }
    browser ??= await chromium.connectOverCDP(`http://127.0.0.1:${sessionPort}`);
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (!page.url().includes("stealth-page")) continue;
        try {
          identity = await page.evaluate(() => JSON.stringify({
            ua: navigator.userAgent,
            platform: navigator.platform,
            chrome: Boolean(window.chrome),
            languages: navigator.languages,
            webdriver: navigator.webdriver,
          }));
        } catch { /* mid-navigation; retry on the same connection */ }
      }
    }
  }
  await browser?.close().catch(() => {});
  if (identity === null) {
    // A turn that "ran" wait_ms in far less than its wait cannot have executed
    // the tools at all — that is the fixture engine, not the stealth browser.
    const impossible = /"durationMs":\d{1,4},/.test(transcript.replace(/\\"/g, "")) && transcript.includes("agent_browser_wait_ms");
    const logTail = readFileSync(fixture.info.logPath, "utf-8").split("\n").slice(-25).join("\n");
    if (impossible) {
      fail(`the fixture engine settled the turn without executing its tools (a wait_ms turn cannot finish in under a second), so the stealth browser was never exercised; re-run on a host whose fixture turns execute tools.\nserver log tail:\n${logTail}`);
    }
    fail(`the test page never appeared in the stealth context during the turn.\ntranscript tail: ${transcript.slice(-1_000)}\nserver log tail:\n${logTail}`);
  }
  if (!/"name":"agent_browser_open".*?"ok":true/.test(transcript) || !/"name":"agent_browser_get_text".*?"ok":true/.test(transcript)) {
    fail(`the bot's turn did not run the scripted browser tools.\ntranscript tail: ${transcript.slice(-1_000)}`);
  }

  const checks = {
    pageIdentity: JSON.parse(identity),
    identityMatchesFingerprint: identity.includes(want),
    identityIsNotThisLinuxHost: !identity.includes("Linux x86_64"),
    cdpBrowser: await fetch(`http://127.0.0.1:${sessionPort}/json/version`).then((r) => r.json() as Promise<{ Browser?: string }>).then((b) => b.Browser),
    fingerprintSessions: readdirSync(stateDir).filter((name) => name.endsWith("-fingerprint.json")),
    portRecord,
  };
  if (!checks.identityMatchesFingerprint) fail(`the browser the bot drove reported an identity that is not the session fingerprint:\n${identity}\n${want}`);
  if (!checks.identityIsNotThisLinuxHost) fail("the browser the bot drove reported this Linux host's platform; stealth did not apply");
  console.log("stealth browser verification passed:");
  console.log(JSON.stringify(checks, null, 2));
} finally {
  // Scoped to this fixture's HOME, never the operator's sessions.
  await promisify(execFile)(binaryPath, ["close", "--all"], { env: { HOME: fixture.info.dataDir, USERPROFILE: fixture.info.dataDir, PATH: process.env.PATH }, timeout: 15_000 }).catch(() => {});
  await fixture.close();
  testPageServer.close();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
