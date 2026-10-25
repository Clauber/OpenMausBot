// Turn previews capture the bot's browser only while a Browser panel watches
// it, and the final conversation screenshot still settles without a viewer.
// Always a disposable fixture HOME; see docs/verification/browser-live.md.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { launchVerificationServer } from "./control-omb.ts";

const binaryPath = process.env.OMB_VERIFY_BROWSER_BINARY;
const executablePath = process.env.OMB_VERIFY_BROWSER_CHROME;
if (!binaryPath || !executablePath) throw new Error("Set OMB_VERIFY_BROWSER_BINARY and OMB_VERIFY_BROWSER_CHROME to explicit installed binaries.");
const gateDir = mkdtempSync(join(tmpdir(), "omb-preview-gate-"));
const gate = join(gateDir, "finish");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const started = Date.now();
const log = (...parts: unknown[]) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s]`, ...parts);
const failures: string[] = [];
const check = (ok: boolean, message: string) => { log(`${ok ? "ok" : "FAIL"} ${message}`); if (!ok) failures.push(message); };

// The fake engine reports this tool call, so the turn earns a settled frame;
// the recipe performs the call itself below, through the turn's own MCP server.
const fixture = await launchVerificationServer({
  ...process.env, FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate,
  FAKE_CLAUDE_TOOL_CALLS: JSON.stringify([{ name: "mcp__browser__agent_browser_open", input: { url: "about:blank" } }]),
}, undefined, undefined, { binaryPath, executablePath });
const url = fixture.info.url;
log("fixture", JSON.stringify(fixture.info));
const api = async (path: string, method = "GET", body?: unknown) => {
  const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, json: await response.json().catch(() => null) as any };
};

// Every successful preview capture broadcasts one `screen` event.
let screens = 0;
let botId = "";
let threadId = "";
const events = new AbortController();
void (async () => {
  const response = await fetch(`${url}/api/events`, { signal: events.signal });
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (threadId && line.startsWith("data:") && line.includes('"kind":"screen"') && line.includes(threadId)) screens++;
    }
  }
})().catch(() => {});
const busy = async () => (await api("/api/bots?messages=0")).json.bots.find((bot: any) => bot.id === botId)?.busy === true;
// The same stream the Browser panel opens.
const viewer = async () => {
  const abort = new AbortController();
  const response = await fetch(`${url}/api/bots/${botId}/browser/live`, { signal: abort.signal });
  if (response.status !== 200) throw new Error(`viewer ${response.status} ${await response.text()}`);
  void (async () => { for await (const _ of response.body as AsyncIterable<Uint8Array>) { /* drain */ } })().catch(() => {});
  return () => abort.abort();
};
const phase = async (ms: number) => { const before = screens; await sleep(ms); return [before, screens] as const; };

let mcp: ChildProcess | undefined;
try {
  await api("/api/config", "PATCH", { features: { browser: true } });
  botId = (await api("/api/bots", "POST", { name: "Pepper" })).json.bot.id;
  const patched = await api(`/api/bots/${botId}`, "PATCH", { browser: true, computer: "browser" });
  if (patched.status !== 200) throw new Error(`bot patch failed: ${patched.status} ${JSON.stringify(patched.json)}`);
  threadId = (await api("/api/bots?messages=0")).json.bots.find((bot: any) => bot.id === botId).threadId;
  const sent = await api(`/api/bots/${botId}/messages`, "POST", { text: "Preview check", threadId });
  if (sent.status !== 202 && sent.status !== 200) throw new Error(`send failed: ${sent.status}`);
  for (let i = 0; i < 30 && !(await busy()); i++) await sleep(500);

  // Act as the model CLI: spawn the browser MCP server from this turn's
  // --mcp-config and open a page, which claims the turn's browser.
  for (let i = 0; i < 40 && !existsSync(fixture.fixtureDumpPath); i++) await sleep(250);
  const server = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig.mcpServers.browser;
  mcp = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "inherit"] });
  const replies = new Map<number, (message: any) => void>();
  let output = "";
  mcp.stdout!.on("data", (data) => {
    output += data;
    let end;
    while ((end = output.indexOf("\n")) >= 0) {
      const message = JSON.parse(output.slice(0, end));
      output = output.slice(end + 1);
      replies.get(message.id)?.(message);
    }
  });
  let nextId = 0;
  const rpc = (method: string, params: unknown) => new Promise<any>((resolve) => {
    replies.set(++nextId, resolve);
    mcp!.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: nextId, method, params })}\n`);
  });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify-browser-preview-watchers", version: "1" } });
  mcp.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const tools: string[] = (await rpc("tools/list", {})).result.tools.map((tool: { name: string }) => tool.name);
  const openTool = tools.find((name) => /(^|_)open$/.test(name));
  const opened = await rpc("tools/call", { name: openTool, arguments: { url: "about:blank" } });
  if (opened.error || opened.result?.isError) throw new Error(`${openTool} failed: ${JSON.stringify(opened.error ?? opened.result)}`);
  await sleep(2000);

  const [a0, a1] = await phase(31_000);
  check(a1 === a0, `no viewer: ${a0} -> ${a1} captures over 31s`);
  let close = await viewer();
  const [b0, b1] = await phase(10_000);
  check(b1 > b0, `viewer open: ${b0} -> ${b1} captures over 10s`);
  close();
  await sleep(2000); // an already-started capture may finish
  const [c0, c1] = await phase(31_000);
  check(c1 === c0, `last viewer closed: ${c0} -> ${c1} captures over 31s`);
  close = await viewer();
  const [d0, d1] = await phase(10_000);
  check(d1 > d0, `reopened: ${d0} -> ${d1} captures over 10s`);
  close();
  await sleep(2000);

  writeFileSync(gate, "");
  for (let i = 0; i < 60 && await busy(); i++) await sleep(500);
  await sleep(1500);
  const messages = (await api(`/api/threads/${threadId}/messages?limit=50`)).json;
  const shot = ((messages.messages ?? messages) as Array<{ id: string; kind?: string }>).filter((message) => message.kind === "screen").at(-1);
  if (!shot) check(false, "final screenshot settled without a viewer");
  else {
    const image = await fetch(`${url}/api/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(shot.id)}/image`);
    const bytes = (await image.arrayBuffer()).byteLength;
    check(image.status === 200 && bytes > 0, `final screenshot without a viewer: HTTP ${image.status}, ${bytes} bytes, ${image.headers.get("content-type")}`);
  }
} finally {
  events.abort();
  mcp?.kill();
  // close --all is scoped to this fixture's HOME, never the operator's.
  await promisify(execFile)(binaryPath, ["close", "--all"], { env: { HOME: fixture.info.dataDir, USERPROFILE: fixture.info.dataDir, PATH: process.env.PATH }, timeout: 15_000 }).catch(() => {});
  await fixture.close();
  rmSync(gateDir, { recursive: true, force: true });
  log("server log kept at", fixture.info.logPath);
}
if (failures.length) process.exit(1);
