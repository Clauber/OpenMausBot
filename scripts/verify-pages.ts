// Full routes, turn capability, durable review card and fake-engine context.
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { removeTempDir } from "../server/testing/cleanup.ts";
import { mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

async function until<T>(read: () => T | Promise<T>, timeout = 20_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { const value = await read(); if (value) return value; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("fixture condition timed out");
}
async function agentsRpc(env: NodeJS.ProcessEnv, method: string, params?: unknown): Promise<any> {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../server/drivers/agents-proxy.ts", import.meta.url))], {
    env, stdio: ["pipe", "pipe", "ignore"],
  });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("agents MCP fixture timed out")), 15_000);
      let buffer = "";
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("exit", () => { clearTimeout(timer); if (!buffer.includes("\n")) reject(new Error("agents MCP exited without response")); });
      child.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        if (buffer.includes("\n")) { clearTimeout(timer); const reply = JSON.parse(buffer.split("\n")[0]!); resolve(reply.result); }
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n");
    });
  } finally { child.stdin.end(); child.kill(); }
}

export async function verifyPages(preview = false, checkUi = false) {
  const gates = mkdtempSync(join(tmpdir(), "omb-pages-gates-")), gate = join(gates, "finish");
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate });
  const evidence: unknown[] = [];
  let ui: MountedPreview | undefined;
  const api = async (method: string, path: string, body?: unknown, status = 200, headers: Record<string, string> = {}) => {
    const response = await fetch(fixture.info.url + path, { method,
      headers: { "content-type": "application/json", origin: fixture.info.url, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    // No authorization headers, tokens or full launch dumps enter evidence.
    evidence.push({ method, path, body, status: response.status, result });
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result)}`);
    return result;
  };
  const control = async (...args: string[]) => {
    const result = await runControlOmb([...args, "--url", fixture.info.url]) as any;
    evidence.push({ command: args, result }); return result;
  };
  const evidencePath = `${fixture.info.logPath}.pages.json`;
  try {
    await api("GET", "/api/pages", undefined, 403, { origin: "https://untrusted.example.com" });
    await api("GET", "/api/pages", undefined, 401, { authorization: "Bearer omb_sess_invalid" });
    const pair = async (path: string, body: unknown) => {
      const response = await fetch(fixture.info.url + path, { method: "POST", headers: { "content-type": "application/json", origin: fixture.info.url }, body: JSON.stringify(body) });
      assert.ok(response.ok); return await response.json() as any;
    };
    const invitation = await pair("/api/auth/pairing", { label: "Pages limited fixture", scopes: ["client"] });
    const member = await pair("/api/auth/pair", { code: invitation.code, label: "Pages limited client" });
    await api("GET", "/api/pages", undefined, 403, { authorization: `Bearer ${member.token}` });
    const page = (await api("POST", "/api/pages", { revision: 0, title: "Launch plan", content: "PAGE_CONTEXT_MARKER_7\n\nShip the living document." }, 201)).page;
    const child = (await api("POST", "/api/pages", { revision: 0, title: "Nested checklist", content: "Checkbox acceptance", parentId: page.id }, 201)).page;
    assert.equal(child.parentId, page.id);
    await api("POST", `/api/pages/${page.id}/move`, { revision: 1, parentId: child.id }, 409);
    await api("PATCH", `/api/pages/${page.id}`, { revision: 1, content: "PAGE_CONTEXT_MARKER_7\n\nRevised launch checklist." });
    const stale = await api("PATCH", `/api/pages/${page.id}`, { revision: 1, content: "stale overwrite" }, 409);
    assert.equal(stale.code, "stale_revision");
    const results = await api("GET", "/api/pages/search?q=launch"); assert.equal(results.pages[0].id, page.id);
    await api("POST", "/api/pages", { revision: 0, title: "x".repeat(161), content: "" }, 400);
    await api("POST", "/api/pages", { revision: 0, title: "Large", content: "x".repeat(100001) }, 400);
    await api("PATCH", `/api/pages/${page.id}`, { content: "revision missing" }, 400);
    await api("POST", "/api/pages", { revision: 2, title: "Stale create", content: "" }, 409);
    const bot = (await api("POST", "/api/bots", { name: "Pages fixture" }, 201)).bot;
    await control("send", "--bot", bot.id, "--task", bot.threadId, "--text", "TRANSCRIPT_MARKER_7 Save this conversation after reviewing the proposed document.");
    const dump = await until(() => JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")));
    const token = dump.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
    assert.ok(token);
    const proposalBody = { fromBotId: bot.id, fromThreadId: bot.threadId, proposalId: "legion-7-proposal",
      draft: { revision: 0, title: "Reviewed page", content: "PROPOSAL_REVIEW_MARKER_7" } };
    await api("POST", "/api/internal/page-proposals", proposalBody, 401);
    const authorized = { authorization: `Bearer ${token}` };
    await api("POST", "/api/internal/page-proposals", { ...proposalBody, fromThreadId: "other-thread" }, 403, authorized);
    const proxyEnv = { PATH: process.env.PATH, HOME: fixture.info.dataDir, OMB_HARNESS_URL: fixture.info.url,
      OMB_BOT_ID: bot.id, OMB_THREAD_ID: bot.threadId, OMB_COMMS_TOKEN: token };
    const catalog = await agentsRpc(proxyEnv, "tools/list");
    assert.ok(catalog.tools.some((tool: any) => tool.name === "propose_page"));
    const toolResult = await agentsRpc(proxyEnv, "tools/call", { name: "propose_page", arguments: {
      proposal_id: proposalBody.proposalId, ...proposalBody.draft,
    } });
    assert.ok(!toolResult.isError, JSON.stringify(toolResult));
    const proposal = JSON.parse(toolResult.content[0].text);
    evidence.push({ mcp: "agents tools/call propose_page", proposal });
    const retry = await api("POST", "/api/internal/page-proposals", { ...proposalBody, draft: { ...proposalBody.draft, title: "Retry must not replace review" } }, 201, authorized);
    assert.equal(retry.requestId, proposal.requestId); assert.equal(retry.messageId, proposal.messageId);
    assert.equal((await api("GET", "/api/pages")).pages.length, 2, "proposal cannot save before review");
    const transcript = await api("GET", `/api/threads/${bot.threadId}/messages`);
    const card = transcript.messages.find((m: any) => m.card?.pageRequest)?.card;
    assert.equal(card.tool, "propose_page"); assert.ok(card.subtitle.includes("PROPOSAL_REVIEW_MARKER_7"));
    let browserProposal: { requestId: string } | undefined;
    if (checkUi) browserProposal = await api("POST", "/api/internal/page-proposals", { ...proposalBody,
      proposalId: "legion-7-browser-proposal", draft: { revision: 0, title: "Browser reviewed page", content: "UI_REVIEW_APPROVAL_7" } }, 201, authorized);
    writeFileSync(gate, "finish");
    await until(async () => !(await api("GET", "/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id).busy);
    const saved = (await api("POST", "/api/pages/from-conversation", { revision: 0, title: "Conversation archive", threadId: bot.threadId }, 201)).page;
    assert.equal(saved.sourceThreadId, bot.threadId); assert.ok(saved.content.includes("TRANSCRIPT_MARKER_7")); assert.ok(saved.content.includes("## Bot"));
    await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: proposal.requestId, behavior: "allow" }, 403, { authorization: `Bearer ${member.token}` });
    const first = await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: proposal.requestId, behavior: "allow" });
    const second = await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: proposal.requestId, behavior: "allow" });
    assert.equal(first.pageId, second.pageId);
    const all = await api("GET", "/api/pages");
    assert.equal(all.pages.filter((p: any) => p.title === "Reviewed page").length, 1);
    evidence.push({ dedupe: { threadId: bot.threadId, proposalId: proposalBody.proposalId, firstPageId: first.pageId, secondPageId: second.pageId, matchingPages: 1 } });
    const chat = await api("POST", `/api/pages/${page.id}/chat`, { revision: 2, botId: bot.id }, 201);
    await control("send", "--bot", bot.id, "--task", chat.task.threadId, "--text", "What is in the page document?");
    await until(() => { const next = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); return (next.systemPrompt + JSON.stringify(next.prompt)).includes("PAGE_CONTEXT_MARKER_7") && next; });
    const pageDump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    evidence.push({ pageChat: { threadId: chat.task.threadId, pageId: page.id, contextMarkerReachedEngine: (pageDump.systemPrompt + JSON.stringify(pageDump.prompt)).includes("PAGE_CONTEXT_MARKER_7"), contextRevision: 2 } });
    await control("wait", "--bot", bot.id, "--task", chat.task.threadId, "--timeout", "20");
    await control("messages", "--bot", bot.id, "--task", chat.task.threadId, "--limit", "10");
    const moved = (await api("POST", `/api/pages/${child.id}/move`, { revision: 1, parentId: null })).page; assert.equal(moved.revision, 2);
    await api("DELETE", `/api/pages/${child.id}`, { revision: 1 }, 409);
    await api("DELETE", `/api/pages/${child.id}`, { revision: 2 });
    let uiEvidence: unknown;
    if (preview || checkUi) {
      await api("PUT", "/api/config", { profile: { name: "Pages verification" } });
      if (checkUi) {
        const { mountPagesBuiltPreview } = await import("./testing/pages-built-preview.ts");
        ui = await mountPagesBuiltPreview(fixture.info.url);
      } else ui = await mountPreview(fixture, { entry: "/scripts/testing/threads-preview.tsx", route: "/__pages.html", title: "Isolated Legion Pages" });
      console.log(JSON.stringify({ ...fixture.info, previewUrl: `${ui.previewUrl}#/pages/${page.id}`, evidencePath }));
      writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
      if (checkUi) {
        const { verifyPagesUi } = await import("./testing/pages-ui.ts");
        uiEvidence = await verifyPagesUi(ui.previewUrl, fixture.info.url, page.id, evidencePath, saved.id, browserProposal?.requestId);
        evidence.push({ uiEvidence });
        console.log(JSON.stringify(uiEvidence));
      }
      if (preview) await parkUntilSignal();
    }
    return { evidencePath, uiEvidence, logPath: fixture.info.logPath, checks: "auth, CRUD, nesting, cycle, 409, search, limits, transcript, card dedupe, engine context" };
  } finally {
    writeFileSync(evidencePath, JSON.stringify(evidence, (_key, value) => typeof value === "string" && value.length > 2000 ? `${value.slice(0, 2000)}… [bounded evidence]` : value, 2));
    await ui?.close(); await fixture.close(); await removeTempDir(gates);
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  console.log(JSON.stringify(await verifyPages(process.argv.includes("--preview"), process.argv.includes("--ui"))));
}
