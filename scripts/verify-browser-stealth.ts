// The built-in stealth browser fixture: a fingerprinted Chrome per session.
//
// Starts a disposable fixture server with the built-in stealth browser
// enabled (browserEngine.stealth). The fake engine runs each scripted call on
// the turn's own browser MCP server (`"server": "browser"`), so the bot's own
// calls go through /api/internal/browser/mcp to the in-process stealth engine against
// loopback test pages. From those tool results the recipe proves the page
// reports a coherent real-Chrome identity, a mocked Cloudflare challenge is
// auto-clicked clear, and no agent-browser process served the session.
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

// The bot's turn: read the identity page, then hold the challenge page while
// the watcher clears it, then read its status. Expected values never appear
// in the inputs, so a result that contains them came from the page.
const identityScript = "JSON.stringify({ ua: navigator.userAgent, platform: navigator.platform, chrome: Boolean(window.chrome), languages: navigator.languages, webdriver: navigator.webdriver })";
process.env.FAKE_CLAUDE_TOOL_CALLS = JSON.stringify([
  { name: "agent_browser_open", input: { url: testPageUrl } },
  { name: "agent_browser_get_text", input: { selector: "#ua" } },
  { name: "agent_browser_eval", input: { script: identityScript } },
  { name: "agent_browser_open", input: { url: challengeUrl } },
  { name: "agent_browser_wait_ms", input: { ms: 15_000 } },
  { name: "agent_browser_eval", input: { script: "document.getElementById('status')?.textContent ?? 'gone'" } },
].map((call) => ({ ...call, server: "browser" })));

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

  // The stealth context launches at the bot's first browser call; its port
  // record appears within seconds of the send.
  const stateDir = join(fixture.info.dataDir, "stealth-browser", "state");
  for (let i = 0; i < 30 && !existsSync(join(stateDir, "debug-ports.json")); i++) {
    await sleep(1_000);
  }
  if (!existsSync(join(stateDir, "debug-ports.json"))) {
    const logTail = readFileSync(fixture.info.logPath, "utf-8").split("\n").slice(-25).join("\n");
    fail(`the stealth browser never launched.\nserver log tail:\n${logTail}`);
  }
  const portRecord = JSON.parse(readFileSync(join(stateDir, "debug-ports.json"), "utf-8")) as Record<string, number>;
  const sessionPort = Object.values(portRecord)[0];
  const fingerprintSessions = readdirSync(stateDir).filter((name) => name.endsWith("-fingerprint.json"));
  if (!fingerprintSessions.length) fail("the stealth browser persisted no session fingerprint");

  // An agent-browser process for this fixture runs with its HOME (the data dir).
  const agentBrowserProcesses = new Set<string>();
  const sampleAgentBrowser = (): void => {
    for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
      try {
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8").replaceAll("\0", " ");
        if (!cmdline.includes("agent-browser")) continue;
        if (readFileSync(`/proc/${pid}/environ`, "utf-8").split("\0").includes(`HOME=${fixture.info.dataDir}`)) agentBrowserProcesses.add(`${pid}: ${cmdline}`);
      } catch { /* exited, or not ours */ }
    }
  };

  // The turn runs the bot's six calls for real (the wait alone is 15s).
  let toolItems: ToolItem[] = [];
  let transcript: unknown = null;
  for (let i = 0; i < 120 && toolItems.length < 6; i++) {
    sampleAgentBrowser();
    await sleep(1_000);
    transcript = (await api(`/api/threads/${threadId}/messages?limit=50`)).json;
    toolItems = toolItemsIn(transcript);
  }
  if (toolItems.length < 6) {
    const logTail = readFileSync(fixture.info.logPath, "utf-8").split("\n").slice(-25).join("\n");
    fail(`the turn settled ${toolItems.length} of 6 browser calls.\ntranscript:\n${JSON.stringify(transcript).slice(-4_000)}\nserver log tail:\n${logTail}`);
  }
  const failed = toolItems.filter((item) => item.ok === false);
  if (failed.length) fail(`browser calls failed through the route:\n${JSON.stringify(failed, null, 2)}`);
  const [, uaText, identityText, , , challengeText] = toolItems.map((item) => item.output);

  // The session's identity is the runtime's Windows Chrome override (UA,
  // platform and client hints together), never this Linux host's own: the
  // page script's #ua text and the bot's eval must both report it.
  const cdpBrowser = await fetch(`http://127.0.0.1:${sessionPort}/json/version`).then((r) => r.json() as Promise<{ Browser?: string }>).then((b) => b.Browser ?? "");
  const major = cdpBrowser.match(/Chrome\/(\d+)/)?.[1] ?? fail(`the stealth context reports no Chrome version: ${cdpBrowser}`);
  const sessionIdentity = (text: string) => text.includes("Windows NT 10.0; Win64; x64") && text.includes(`Chrome/${major}.0.0.0`) && /Win32/.test(text) && !text.includes("Linux");
  const identity = String(identityText);
  const coherent = sessionIdentity(String(uaText)) && sessionIdentity(identity) && /\\?"webdriver\\?":false/.test(identity);
  if (!coherent) fail(`the page did not report the session's identity:\n${uaText}\n${identity}`);
  if (!String(challengeText).includes("cleared")) fail(`the cloudflare challenge mock was not auto-cleared (status: ${challengeText})`);

  // The in-process engine served every call: no agent-browser daemon or CLI
  // ran for this fixture, and the server never mounted one on the session.
  sampleAgentBrowser();
  if (agentBrowserProcesses.size) fail(`agent-browser ran for the stealth session:\n${[...agentBrowserProcesses].join("\n")}`);
  const serverLog = readFileSync(fixture.info.logPath, "utf-8");
  if (/mounts through|agent-browser/i.test(serverLog)) fail(`the server log shows agent-browser activity:\n${serverLog.split("\n").filter((line) => /mounts through|agent-browser/i.test(line)).join("\n")}`);

  const checks = {
    toolResults: toolItems.map((item) => ({ ok: item.ok, output: String(item.output).slice(0, 160) })),
    identityCoherent: coherent,
    cloudflareAutoClick: "cleared",
    agentBrowserProcesses: 0,
    cdpBrowser,
    fingerprintSessions,
    portRecord,
  };
  console.log("stealth browser verification passed:");
  console.log(JSON.stringify(checks, null, 2));
} finally {
  // Scoped to this fixture's HOME, never the operator's sessions.
  await promisify(execFile)(binaryPath, ["close", "--all"], { env: { HOME: fixture.info.dataDir, USERPROFILE: fixture.info.dataDir, PATH: process.env.PATH }, timeout: 15_000 }).catch(() => {});
  await fixture.close();
  testPageServer.close();
}

type ToolItem = { ok?: boolean; output: string };
/** The thread's tool activity in order, each result's text blocks joined. */
function toolItemsIn(transcript: unknown): ToolItem[] {
  const messages = (transcript as { messages?: Array<{ tool?: { ok?: boolean; output?: string } }> } | null)?.messages ?? [];
  return messages.flatMap(({ tool }) => {
    if (!tool || tool.output === undefined) return [];
    let blocks: unknown = tool.output;
    try { blocks = JSON.parse(tool.output); } catch { /* a plain-text preview */ }
    const output = Array.isArray(blocks)
      ? blocks.map((block: { text?: unknown }) => typeof block?.text === "string" ? block.text : JSON.stringify(block?.text)).join("\n")
      : String(blocks);
    return [{ ok: tool.ok, output }];
  });
}
