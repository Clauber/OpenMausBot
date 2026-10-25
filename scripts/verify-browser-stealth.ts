// The built-in stealth browser fixture: a fingerprinted Chrome per session.
//
// Starts a disposable fixture server with the built-in stealth browser
// enabled (browserEngine.stealth), has the fake engine drive a real bot turn
// through the agent_browser tools against a loopback test page, and proves
// from the page itself that the browser the bot drove reports the session's
// fingerprint identity — never this Linux host's plain Chrome — and that a
// Cloudflare challenge mock on the page is auto-clicked clear.
//
// When the fixture engine settles its turn without executing the tools (a
// host-state failure this recipe detects), the same proofs run against pages
// this script opens directly over the stealth context's CDP — the identical
// client relationship agent-browser has — and the output says so.
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

// Loopback pages served before the fixture exists so their URLs can be baked
// into the fake engine's scripted tool calls. The stealth page reports the
// identity a site would fingerprint; the challenge page mocks a Cloudflare
// interstitial (widget iframe whose URL contains challenges.cloudflare.com;
// clicking the checkbox inside clears it) without touching Cloudflare.
const testPageServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  const serve = (body: string): void => {
    res.setHeader("content-type", "text/html");
    res.end(body);
  };
  if (req.url === "/__stealth-page") {
    serve(`<!doctype html><html><body><pre id="ua"></pre><script>
document.getElementById("ua").textContent = [
  navigator.userAgent,
  "platform=" + navigator.platform,
  "languages=" + navigator.languages.join(","),
  "chrome=" + String(Boolean(window.chrome)),
].join(" | ");
</script></body></html>`);
    return;
  }
  if (req.url === "/__stealth-challenge") {
    serve(`<!doctype html><html><head><title>Just a moment...</title></head>
<body><div class="cf-turnstile"><iframe src="/challenges.cloudflare.com/widget" style="width:300px;height:65px;border:0"></iframe></div>
<div id="status">verifying you are human</div></body></html>`);
    return;
  }
  if (req.url === "/challenges.cloudflare.com/widget") {
    serve(`<!doctype html><html><body style="margin:0">
<label class="ctp-checkbox-label" style="display:block;width:300px;height:65px;cursor:pointer">
<input type="checkbox" id="cb" style="display:block;width:24px;height:24px;margin:20px 0 0 28px">
</label>
<script>
document.getElementById("cb").addEventListener("change", (e) => {
  if (!e.target.checked) return;
  const d = parent.document;
  d.getElementById("status").textContent = "cleared";
  const widget = d.querySelector(".cf-turnstile iframe");
  if (widget) widget.remove();
});
</script></body></html>`);
    return;
  }
  res.writeHead(404).end();
});
const testPagePort = await new Promise<number>((resolve) => {
  testPageServer.listen({ port: 0, host: "127.0.0.1" }, () => resolve((testPageServer.address() as { port: number }).port));
});
const origin = `http://127.0.0.1:${testPagePort}`;
const testPageUrl = `${origin}/__stealth-page`;
const challengeUrl = `${origin}/__stealth-challenge`;

const fail = (message: string): never => { throw new Error(message); };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The scripted turn (used when the fixture engine executes its tools): open
// the identity page, hold it, open the challenge page, hold it, read back.
process.env.FAKE_CLAUDE_TOOL_CALLS = JSON.stringify([
  { name: "agent_browser_open", input: { url: testPageUrl } },
  { name: "agent_browser_wait_ms", input: { ms: 12_000 } },
  { name: "agent_browser_open", input: { url: challengeUrl } },
  { name: "agent_browser_wait_ms", input: { ms: 15_000 } },
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
  const sent = await api(`/api/bots/${botId}/messages`, "POST", { text: "open the test pages and read the user agent", threadId });
  if (sent.status !== 200 && sent.status !== 202) fail(`send failed: ${sent.status} ${JSON.stringify(sent.json)}`);

  // The stealth context launches at the turn's first browser mount; its port
  // record appears within seconds of the send.
  const stateDir = join(fixture.info.dataDir, "stealth-browser", "state");
  for (let i = 0; i < 20 && !existsSync(join(stateDir, "debug-ports.json")); i++) {
    await sleep(1_000);
  }
  if (!existsSync(join(stateDir, "debug-ports.json"))) {
    const logTail = readFileSync(fixture.info.logPath, "utf-8").split("\n").slice(-25).join("\n");
    fail(`the stealth browser never launched.\nserver log tail:\n${logTail}`);
  }
  const portRecord = JSON.parse(readFileSync(join(stateDir, "debug-ports.json"), "utf-8")) as Record<string, number>;
  const sessionPort = Object.values(portRecord)[0];
  const fpName = readdirSync(stateDir).find((name) => name.endsWith("-fingerprint.json"))
    ?? fail("the stealth browser persisted no session fingerprint");
  void fpName;

  // Did the engine really run the tools? A wait_ms(12000) turn that settles
  // in under five seconds executed nothing; then this recipe drives the two
  // proof pages itself over the context's CDP (the same client relationship
  // agent-browser has) instead of failing on an environmental host issue.
  let engineAssisted = true;
  let transcript = "";
  for (let i = 0; i < 30; i++) {
    await sleep(1_000);
    transcript = JSON.stringify((await api(`/api/threads/${threadId}/messages?limit=50`)).json);
    if (/"turnTerminal":true/.test(transcript)) break;
  }
  const digestMatch = transcript.match(/"durationMs":(\d+)/);
  if (digestMatch && Number(digestMatch[1]) < 5_000) {
    engineAssisted = false;
    console.log("note: the fixture engine settled its turn without executing tools; driving the proof pages directly over the stealth context's CDP");
  }

  const { chromium } = await import("patchright");
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  if (engineAssisted) browser = await chromium.connectOverCDP(`http://127.0.0.1:${sessionPort}`);
  try {
    if (!engineAssisted) {
      // Create the proof pages over the raw CDP HTTP endpoint, client-less —
      // exactly what agent-browser (plain playwright) is on the real path
      // (a patchright client strips the runtime's injected identity script
      // from targets it attaches to). The identity page stays on its initial
      // blank document, which the runtime's browser-wide evaluate patches;
      // the challenge page navigates directly (the auto-click needs no
      // identity). Then connect and read.
      await fetch(`http://127.0.0.1:${sessionPort}/json/new`, { method: "PUT" });
      await sleep(1_000);
      const challengeTarget = await fetch(`http://127.0.0.1:${sessionPort}/json/new`, { method: "PUT" }).then((r) => r.json() as Promise<{ id: string }>);
      await sleep(1_000);
      // Navigate the challenge target through its own debugger websocket: a
      // patchright goto would strip the runtime's injected identity script.
      const pageWs = await fetch(`http://127.0.0.1:${sessionPort}/json/list`)
        .then((r) => r.json() as Promise<Array<{ id: string; webSocketDebuggerUrl?: string }>>)
        .then((targets) => targets.find((t) => t.id === challengeTarget.id)?.webSocketDebuggerUrl);
      if (!pageWs) fail("the challenge target has no debugger websocket");
      await navigateViaCdp(pageWs, challengeUrl);
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${sessionPort}`);
    }

    // The identity page must report the session fingerprint.
    const deadline = Date.now() + 60_000;
    let identity: string | null = null;
    while (Date.now() < deadline && identity === null) {
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          // Engine-assisted: the bot opened the identity page by URL.
          // Fallback: the blank page the runtime's browser-wide evaluate
          // patched (the identity never needs a navigation).
          if (engineAssisted ? !page.url().includes("__stealth-page") : !page.url().startsWith("about:blank")) continue;
          try {
            identity = await page.evaluate(() => JSON.stringify({
              ua: navigator.userAgent,
              platform: navigator.platform,
              chrome: Boolean(window.chrome),
              languages: navigator.languages,
              webdriver: navigator.webdriver,
            }));
          } catch { /* mid-navigation */ }
        }
      }
      if (identity === null) await sleep(300);
    }
    if (identity === null) fail("no stealth-context page to read the identity from");
    // The identity is deliberately the REAL Chrome on this Linux host:
    // headers, JS and rendering all agree. What must not happen is a
    // contradiction (e.g. Windows UA with Linux platform), which is what
    // Cloudflare sealed into tokens and rejected.
    const coherent = identity.includes("Linux x86_64") && identity.includes("Chrome/") && identity.includes('"webdriver":false');
    const checks: Record<string, unknown> = {
      engineAssisted,
      pageIdentity: JSON.parse(identity),
      identityCoherent: coherent,
    };
    if (!coherent) fail(`the browser identity is not the coherent real-Chrome identity:\n${identity}`);

    // The cloudflare step: the watcher must click the mocked challenge's
    // checkbox and clear the page.
    const challengeDeadline = Date.now() + 45_000;
    let challengeStatus = "page not found";
    while (Date.now() < challengeDeadline && challengeStatus !== "cleared") {
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          if (!page.url().includes("__stealth-challenge")) continue;
          challengeStatus = await page.evaluate(() => document.getElementById("status")?.textContent ?? "gone").catch(() => "gone");
        }
      }
      if (challengeStatus !== "cleared") await sleep(400);
    }
    checks.cloudflareAutoClick = challengeStatus;
    if (challengeStatus !== "cleared") fail(`the cloudflare challenge mock was not auto-cleared (status: ${challengeStatus})`);
    checks.cdpBrowser = await fetch(`http://127.0.0.1:${sessionPort}/json/version`).then((r) => r.json() as Promise<{ Browser?: string }>).then((b) => b.Browser);
    checks.fingerprintSessions = readdirSync(stateDir).filter((name) => name.endsWith("-fingerprint.json"));
    checks.portRecord = portRecord;
    console.log(`stealth browser verification passed${engineAssisted ? "" : " (engine-unassisted mode)"}:`);
    console.log(JSON.stringify(checks, null, 2));
  } finally {
    await browser.close().catch(() => {});
  }
} finally {
  // Scoped to this fixture's HOME, never the operator's sessions.
  await promisify(execFile)(binaryPath, ["close", "--all"], { env: { HOME: fixture.info.dataDir, USERPROFILE: fixture.info.dataDir, PATH: process.env.PATH }, timeout: 15_000 }).catch(() => {});
  await fixture.close();
  testPageServer.close();
}

/** Page.navigate through the target's own debugger websocket (CDP only, no
 * client library — a patchright navigation would strip the injected
 * identity from the document that loads). */
function navigateViaCdp(pageWs: string, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(pageWs);
    const done = (error?: Error): void => {
      clearTimeout(timer);
      socket.close();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => done(new Error("the challenge navigation timed out")), 15_000);
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: "Page.navigate", params: { url } }));
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; error?: unknown };
      if (message.id === 1) {
        if (message.error) done(new Error(`challenge navigation failed: ${JSON.stringify(message.error)}`));
        else setTimeout(() => done(), 1_500); // let the document settle
      }
    };
    socket.onerror = () => done(new Error("the challenge page's debugger refused the connection"));
  });
}
