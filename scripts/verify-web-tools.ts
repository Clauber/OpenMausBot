// web_fetch / web_search against a real harness (fake engine) and a loopback
// fake web server on 127.0.0.2, in a throwaway data directory. Run directly:
//   node --experimental-strip-types scripts/verify-web-tools.ts
// 127.0.0.2 is the one extra loopback address the sealed fixture admits
// (OMB_TEST_WEB_FIXTURE_HOST); 127.0.0.1 and every private range stay refused.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";

/** A fixture server holding one bot's turn open, so its agents capability stays valid. */
export async function startHeldFixture(env: NodeJS.ProcessEnv = {}, botPatch?: Record<string, unknown>) {
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "hang", ...env });
  const { url } = fixture.info;
  const api = async (method: string, path: string, body?: unknown, expected = 200, token?: string) => {
    const response = await fetch(url + path, { method, headers: { origin: url, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    const result = text ? JSON.parse(text) : {};
    assert.equal(response.status, expected, `${method} ${path}: ${text.slice(0, 300)}`);
    return result;
  };
  const bot = (await api("POST", "/api/bots", { name: "Legion web fixture", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }, 201)).bot;
  // Tool selection can only change while the bot is idle, so patch before the turn starts.
  if (botPatch) await api("PATCH", `/api/bots/${bot.id}`, botPatch);
  await runControlOmb(["send", "--url", url, "--bot", bot.id, "--task", bot.threadId, "--text", "Hold this fixture while web tools are exercised."]);
  const deadline = Date.now() + 20_000;
  while (!existsSync(fixture.fixtureDumpPath)) {
    if (Date.now() > deadline) throw new Error("fake engine did not start");
    await delay(50);
  }
  const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
  // A bot with a tool selection gets the agents server wrapped by the MCP gate; the token is then upstream.
  const agents = dump.mcpConfig.mcpServers.agents.env;
  const token = (agents.OMB_COMMS_TOKEN ?? JSON.parse(agents.OMB_GATE_UPSTREAM).env.OMB_COMMS_TOKEN) as string;
  return { fixture, url, api, bot, token };
}

const DDG = (items: Array<[string, string, string]>) => `<html><body>${items.map(([href, title, snippet]) =>
  `<div class="result"><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(href)}&amp;rut=abc">${title}</a></h2>` +
  `<a class="result__snippet" href="x">${snippet}</a></div>`).join("")}</body></html>`;

export async function verifyWebTools() {
  const hits: Record<string, number> = {};
  const web = createServer((req, res) => {
    hits[req.url ?? ""] = (hits[req.url ?? ""] ?? 0) + 1;
    if (req.url === "/page") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      return void res.end("<html><head><title>Fixture &amp; Page</title><style>p{}</style></head><body><script>evil()</script><h1>Hello</h1><p>Readable <b>text</b> here.</p></body></html>");
    }
    if (req.url === "/big") {
      res.setHeader("content-type", "text/plain");
      return void res.end("word ".repeat(40_000));
    }
    if (req.url === "/redir") {
      res.writeHead(302, { location: "http://10.0.0.1/secret" });
      return void res.end();
    }
    if (req.url === "/search" && req.method === "POST") {
      req.resume();
      res.setHeader("content-type", "text/html");
      return void res.end(DDG([
        ["https://example.com/one", "First &amp; best", "Snippet one"],
        ["https://example.org/two", "Second", "Snippet two"],
        ["https://example.net/three", "Third", "Snippet three"],
      ]));
    }
    res.statusCode = 404;
    res.end("nope");
  });
  await new Promise<void>((resolve) => web.listen(0, "127.0.0.2", resolve));
  const base = `http://127.0.0.2:${(web.address() as { port: number }).port}`;
  const held = await startHeldFixture({ OMB_TEST_WEB_FIXTURE_HOST: "127.0.0.2" });
  const { api, token } = held;
  const say = (line: string) => process.stdout.write(`${line}\n`);
  try {
    await api("PATCH", "/api/config", { webSearch: { provider: "duckduckgo-html", url: `${base}/search` } });
    const fetchTool = (url: string, expected = 200) => api("POST", "/api/internal/web-fetch", { url }, expected, token);

    // (a) cleaned text, 30k cap, cache
    const page = await fetchTool(`${base}/page`);
    assert.equal(page.title, "Fixture & Page");
    assert.ok(page.text.includes("Hello") && page.text.includes("Readable text here."));
    assert.ok(!/evil|<|p\{\}/.test(page.text), page.text);
    assert.equal(page.cached, false);
    const again = await fetchTool(`${base}/page`);
    assert.equal(again.cached, true);
    assert.equal(hits["/page"], 1);
    const big = await fetchTool(`${base}/big`);
    assert.equal(big.text.length, 30_000);
    assert.equal(big.truncated, true);
    say(`(a) PASS cleaned text + title, big page capped at ${big.text.length} chars, 2nd fetch cached (fixture saw ${hits["/page"]} request)`);

    // (b) SSRF
    const refusals: string[] = [];
    for (const target of ["http://127.0.0.1/", "http://10.0.0.1/", "http://localhost/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/", "ftp://example.com/", `${base}/redir`]) {
      const status = target.startsWith("ftp") ? 502 : 403;
      const refused = await fetchTool(target, status);
      assert.match(refused.error, /not a public web address|Only http and https/, `${target}: ${refused.error}`);
      refusals.push(`${target} -> ${refused.error}`);
    }
    assert.equal(hits["/secret"], undefined);
    const decisions = (await api("GET", "/api/decisions")).decisions as Array<{ tool?: string; source: string; decision: string; summary?: string; rule?: string }>;
    const logged = decisions.filter((d) => d.tool === "web_fetch" && d.source === "outbound" && d.rule === "ssrf-private-host");
    assert.ok(logged.length >= 5, `decision log rows: ${logged.length}`);
    say(`(b) PASS ${refusals.length} targets refused (loopback, private, localhost via DNS, IPv6, metadata, scheme, redirect-to-private); ${logged.length} decision-log rows`);
    for (const line of refusals) say(`      ${line}`);

    // (c) search
    const search = await api("POST", "/api/internal/web-search", { query: "legion fixture" }, 200, token);
    assert.deepEqual(search.results.map((r: { url: string }) => r.url), ["https://example.com/one", "https://example.org/two", "https://example.net/three"]);
    assert.equal(search.results[0].title, "First & best");
    assert.equal(search.results[2].snippet, "Snippet three");
    say("(c) PASS web_search parsed 3 results with titles, unwrapped URLs and snippets");

  } finally {
    web.closeAllConnections();
    web.close();
    await held.fixture.close();
  }

  // (d) tool selection: a bot whose selection denies web_fetch, set before its turn.
  const scoped = await startHeldFixture({}, { toolScope: { deny: ["mcp:agents:web_fetch"] } });
  try {
    const denied = await scoped.api("POST", "/api/internal/web-fetch", { url: "https://example.com/" }, 403, scoped.token);
    assert.match(denied.error, /turned off for this bot/);
    await scoped.api("PATCH", "/api/config", { webSearch: { provider: "duckduckgo-html", url: "http://127.0.0.1:9/never" } });
    const search = await fetch(`${scoped.url}/api/internal/web-search`, { method: "POST", headers: { authorization: `Bearer ${scoped.token}`, "content-type": "application/json" }, body: JSON.stringify({ query: "x" }) });
    assert.notEqual(search.status, 403, "web_search stays allowed when only web_fetch is denied");
    process.stdout.write(`(d) PASS bot with web_fetch denied: ${denied.error} (web_search is not blocked by the selection)\n`);
  } finally {
    await scoped.fixture.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await verifyWebTools();
