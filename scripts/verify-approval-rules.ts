// Real harness and fake engine; judge and connector HTTP boundaries are loopback.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";

export async function verifyApprovalRules() {
  let judgeChoice = "allow", probability = 0.98, judgeUnavailable = false;
  const executed: any[] = [], judgeCalls: any[] = [];
  let upstreamUrl = "";
  const upstream = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const send = (body: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/v1/systemone") {
      const body = JSON.parse(raw); judgeCalls.push(body);
      if (judgeUnavailable) return send({}, 503);
      if (body.questions?.answer?.type === "noul") return send({ answers: { answer: { noul: 0.99 } } });
      assert.equal(body.model, "jev-latest");
      assert.deepEqual(Object.keys(body.questions.answer.criteria), ["allow", "ask", "deny"]);
      const other = judgeChoice === "ask" ? "allow" : "ask";
      return send({ answers: { answer: { choice: judgeChoice, probabilities: { [judgeChoice]: probability, [other]: 1 - probability } } } });
    }
    if (req.url === "/mcp") {
      const body = JSON.parse(raw);
      if (body.method === "tools/call") executed.push(body);
      return send({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "fixture executed" }] } });
    }
    if (req.url?.startsWith("/api/tool_router/session/legion-fixture/toolkits")) return send({ items: [{ slug: "gmail", name: "Gmail" }, { slug: "files", name: "Files" }] });
    if (req.url === "/api/tool_router/session/legion-fixture") return send({ session_id: "legion-fixture", mcp: { type: "http", url: upstreamUrl + "/mcp" }, config: { multi_account: { enable: true, max_accounts_per_toolkit: 10, require_explicit_selection: true } } });
    return send({ items: [] });
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "hang" }, undefined, undefined, undefined, undefined, [], undefined, undefined,
    { judgeUrl: upstreamUrl, connectorUrl: upstreamUrl });
  const { url, logPath } = fixture.info;
  const sockets: Socket[] = [];
  const evidence: Record<string, any> = { base: "bc8665df", fixture: { url, logPath }, checks: {} };
  const api = async (method: string, path: string, body?: unknown, expected = 200, token?: string) => {
    const response = await fetch(url + path, { method, headers: { origin: url, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
    const result = await response.json() as any;
    assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(result)}`);
    return result;
  };
  const poll = async (read: () => Promise<any>, label: string) => {
    const end = Date.now() + 15_000;
    while (Date.now() < end) { const value = await read(); if (value) return value; await delay(50); }
    throw new Error(`Timed out: ${label}`);
  };
  try {
    const bot = (await api("POST", "/api/bots", { name: "Legion approval fixture", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }, 201)).bot;
    // Configure before work starts; all action grants are fixture-owned.
    await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "auto", composio: true, outbound: { policy: "allow", dailyCap: 20 }, approvalRules: { tools: { "native:Write": "require_approval", GMAIL_SEND_EMAIL: "require_approval" } } });
    await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { approvalMode: "auto", title: "Send the approved update to fixture@example.com; remove the approved fixture file" });
    // Prove workspace defaults and validation through the real settings API.
    await api("PATCH", "/api/config", { approvalRules: { categories: { destructive: "require_approval" } } });
    await api("PATCH", `/api/bots/${bot.id}`, { approvalRules: { categories: { invented: "always_allow" } } }, 400);
    const pair = await api("POST", "/api/auth/pairing", { label: "Member fixture", scopes: ["client"] });
    const member = await api("POST", "/api/auth/pair", { code: pair.code });
    await api("PATCH", `/api/bots/${bot.id}`, { approvalRules: {} }, 403, member.token);
    const start = await runControlOmb(["send", "--url", url, "--bot", bot.id, "--task", bot.threadId, "--text", "Hold this fixture while approval policies are exercised."]);
    evidence.start = start;
    await poll(async () => existsSync(fixture.fixtureDumpPath), "fake engine start");
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    const socketPath = dump.mcpConfig.mcpServers.ogb.args.at(-1);
    // Read the actual engine's turn-scoped MCP credential without ever logging it.
    const proxy = dump.mcpConfig.mcpServers.composio;
    assert.ok(proxy, "connector proxy was injected");
    const token = proxy.env.OMB_CONNECTOR_TOKEN;
    assert.ok(token, "turn-scoped token is available");
    const connector = (tool: string, args: unknown, status = 200) => api("POST", "/api/internal/connectors/mcp", { jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name: tool, arguments: args } }, status, token);
    const messages = async () => (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).messages as any[];
    const pending = () => poll(async () => (await messages()).findLast(row => row.card?.outboundRequest && !row.card.answered), "approval card");
    const answer = (row: any, behavior: string, status = 200) => api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: row.card.requestId, behavior }, status);
    // a: requirement overrides both auto level and outbound allowance.
    let held = connector("GMAIL_SEND_EMAIL", { to: "fixture@example.com", body: "rule forced approval" });
    let card = await pending();
    assert.equal(executed.length, 0); assert.match(card.card.held, /rule/); assert.equal(card.card.effectKey.length, 64);
    await answer(card, "allow"); await held;
    assert.equal(executed.length, 1);
    evidence.checks.a = { card: card.card, executed: executed.length, mode: "auto" };
    console.log("PASS (a) require_approval at Auto with daily allowance raises an approval card");
    // Native broker uses the same rules layer.
    const socket = connect(socketPath); sockets.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const nativeId = randomUUID();
    const nativeReply = new Promise<any>(resolve => socket.once("data", bytes => resolve(JSON.parse(String(bytes).trim()))));
    socket.write(JSON.stringify({ t: "ask", id: nativeId, tool: "Write", input: { file_path: "/tmp/legion-fixture.txt", content: "fixture" } }) + "\n");
    const nativeCard = await poll(async () => (await messages()).find(row => row.card?.requestId === nativeId), "native approval card");
    assert.match(nativeCard.card.held, /rule/);
    await answer(nativeCard, "deny"); assert.equal((await nativeReply).behavior, "deny");
    evidence.native = nativeCard.card;
    const destructiveId = randomUUID();
    const destructiveReply = new Promise<any>(resolve => socket.once("data", bytes => resolve(JSON.parse(String(bytes).trim()))));
    socket.write(JSON.stringify({ t: "ask", id: destructiveId, tool: "mcp__files__delete_file", input: { path: "/tmp/legion-native-fixture" } }) + "\n");
    const destructiveCard = await poll(async () => (await messages()).find(row => row.card?.requestId === destructiveId), "native consequential card");
    assert.equal(destructiveCard.card.effectKey.length, 64);
    await api("POST", `/api/bots/${bot.id}/respond`, { requestId: destructiveId, behavior: "allow" });
    assert.equal((await destructiveReply).behavior, "allow");
    assert.equal((await answer(destructiveCard, "allow", 409)).code, "effect_replayed");
    evidence.nativeConsequential = destructiveCard.card;
    // Preallowed harness tools must still pass the same rules gate.
    const agentsToken = dump.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
    const deletion = api("POST", "/api/internal/bot-deletion-requests", { targetBotId: bot.id, reason: "fabricated deletion" }, 403, agentsToken);
    const deletionCard = await pending();
    assert.match(deletionCard.card.tool, /propose_bot_deletion/);
    assert.match(deletionCard.card.held, /rule/);
    evidence.wait = await runControlOmb(["wait", "--url", url, "--bot", bot.id, "--task", bot.threadId, "--timeout", "1"]);
    await answer(deletionCard, "deny"); await deletion;
    assert.ok((await api("GET", "/api/bots")).bots.some((row: any) => row.id === bot.id));
    evidence.internal = deletionCard.card;
    await api("PATCH", `/api/bots/${bot.id}`, { approvalRules: { tools: { GMAIL_SEND_EMAIL: "require_approval", "mcp:agents:propose_routine_action": "require_approval" } } });
    const routine = api("POST", "/api/internal/routine-requests", { action: "pause", routineId: "fabricated-routine" }, 403, agentsToken);
    const routineCard = await pending();
    assert.equal(routineCard.card.tool, "mcp__agents__propose_routine_action");
    await answer(routineCard, "deny"); await routine;
    evidence.internalRoutine = routineCard.card;
    // b: exact rule grants still count and record their rule.
    await api("PATCH", `/api/bots/${bot.id}`, { approvalRules: { tools: { GMAIL_SEND_EMAIL: "always_allow" } } });
    await connector("GMAIL_SEND_EMAIL", { to: "fixture@example.com", body: "always allowed" });
    const allowance = await api("GET", `/api/bots/${bot.id}/outbound`);
    assert.equal(allowance.today, 2);
    const receipt = await poll(async () => (await api("GET", "/api/decisions")).decisions.find((row: any) => row.source === "approval-rules" && row.rule?.includes("daily-allowance:2/20")), "rule receipt");
    evidence.checks.b = { receipt, allowance, executed: executed.length };
    console.log("PASS (b) always_allow records decision-log rule and allowance (2/20)");
    // c: high-confidence deny, explicit ask and low-confidence allow.
    judgeChoice = "deny";
    const beforeDeny = executed.length;
    const denial = await connector("GMAIL_SEND_EMAIL", { to: "fixture@example.com", body: "fabricated unauthorized send" });
    assert.equal(denial.result.isError, true); assert.equal(executed.length, beforeDeny);
    const reviews: any[] = [];
    for (const [choice, confidence, body] of [["ask", 0.98, "judge asks"], ["allow", 0.55, "uncertain send"]] as const) {
      judgeChoice = choice; probability = confidence;
      held = connector("GMAIL_SEND_EMAIL", { to: "fixture@example.com", body }); card = await pending();
      assert.equal(card.card.autoReview.decision, "ask"); assert.equal(executed.length, beforeDeny);
      reviews.push(card.card.autoReview); await answer(card, "deny"); await held;
    }
    const judgeReceipts = (await api("GET", "/api/decisions")).decisions.filter((row: any) => row.source === "auto-review");
    assert.ok(judgeReceipts.some((row: any) => row.decision === "auto-denied" && row.reasoning));
    evidence.checks.c = { denial, reviews, receipts: judgeReceipts };
    console.log("PASS (c) loopback Jev denies unauthorized action; explicit ask and low-confidence allow raise cards");
    // d: concurrent retries dispatch once, replays give 409, card retry cannot re-execute.
    judgeChoice = "allow"; probability = 0.98;
    const args = { to: "fixture@example.com", body: "once only" };
    const beforeReplay = executed.length;
    const concurrent = await Promise.all([args, { body: "once only", to: "fixture@example.com" }].map(async arguments_ => {
      const response = await fetch(url + "/api/internal/connectors/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name: "GMAIL_SEND_EMAIL", arguments: arguments_ } }), signal: AbortSignal.timeout(20_000) });
      return { status: response.status, body: await response.json() as any };
    }));
    assert.deepEqual(concurrent.map(reply => reply.status).sort(), [200, 409]);
    assert.equal(concurrent.find(reply => reply.status === 409)!.body.code, "effect_replayed");
    const replay = await connector("GMAIL_SEND_EMAIL", { body: "once only", to: "fixture@example.com" }, 409);
    assert.equal(replay.code, "effect_replayed"); assert.equal(executed.length, beforeReplay + 1);
    const cardReplay = await answer((await messages()).find(row => row.card?.requestId === evidence.checks.a.card.requestId), "allow", 409);
    assert.equal(cardReplay.code, "effect_replayed");
    const duplicated = { tool_slug: "GMAIL_SEND_EMAIL", arguments: { to: "fixture@example.com", body: "duplicate child" } };
    const batchReplay = await connector("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [duplicated, duplicated] }, 409);
    assert.equal(batchReplay.code, "effect_replayed"); assert.equal(executed.length, beforeReplay + 1);
    evidence.checks.d = { concurrent, replay, cardReplay, batchReplay, executedForKey: executed.length - beforeReplay };
    console.log("PASS (d) normalized duplicate and retried approved card return 409 effect_replayed; executed once");
    // Unavailable judge falls back to the existing allowance/rule decision.
    judgeUnavailable = true;
    await connector("GMAIL_SEND_EMAIL", { to: "fixture@example.com", body: "judge unavailable fallback" });
    evidence.fallback = "unavailable judge allowed via configured rule; accounted";
    evidence.messages = await runControlOmb(["messages", "--url", url, "--bot", bot.id, "--task", bot.threadId, "--limit", "100"]);
    evidence.judgeRequests = judgeCalls.length;
    await runControlOmb(["interrupt", "--url", url, "--bot", bot.id, "--task", bot.threadId]);
    evidence.settled = await runControlOmb(["wait", "--url", url, "--bot", bot.id, "--task", bot.threadId, "--timeout", "5"]);
    writeFileSync(logPath + ".approval-rules.json", JSON.stringify(evidence, null, 2), { mode: 0o600 });
    console.log(`Evidence: ${logPath}.approval-rules.json`);
    return evidence;
  } finally {
    for (const socket of sockets) socket.destroy();
    await fixture.close();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
}
/** Attach only to the explicitly supplied control-omb disposable UI handle. */
export async function verifyApprovalRulesUi(handlePath: string) {
  assert.match(handlePath, /^\/tmp\/openmausbot-verify-data-[^/]+\/ui\.json$/);
  const handle = JSON.parse(readFileSync(handlePath, "utf8"));
  const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", handlePath, ...args]);
  const snapshot = () => ui("snapshot") as Promise<any>;
  const snapshotWith = async (text: string) => {
    const end = Date.now() + 10_000;
    while (Date.now() < end) { const value = await snapshot(); if (JSON.stringify(value).includes(text)) return value; await delay(100); }
    throw new Error(`UI did not show ${text}`);
  };
  const open = async () => {
    let refs = (await snapshot()).refs;
    if (!Object.values(refs).some((ref: any) => ref.name === "Close settings")) {
      refs = (await snapshotWith("Open Pepper's profile")).refs;
      const profile = Object.entries(refs).findLast(([, ref]: any) => ref.name === "Open Pepper's profile");
      assert.ok(profile); await ui("click", "--ref", "@" + profile[0]);
      await snapshotWith("Permissions");
    }
    if (!Object.values((await snapshot()).refs).some((ref: any) => ref.name === "Always allow tools")) await ui("click", "--name", "Permissions");
    await snapshotWith("Always allow tools");
  };
  const fill = async (name: string, text: string) => {
    await ui("click", "--name", name); await ui("press", "--keys", "Control+a");
    await ui("press", "--keys", "Backspace"); if (text) await ui("type", "--name", name, "--text", text);
  };
  await open();
  await fill("Always allow tools", "native:Read");
  await fill("Require approval tools", "mcp:mail:send_email");
  await ui("click", "--name", "Approval rule for send-like");
  await ui("press", "--keys", "Home"); await ui("press", "--keys", "ArrowDown");
  await ui("press", "--keys", "ArrowDown"); await ui("press", "--keys", "Enter");
  await ui("click", "--name", "Save approval rules");
  const saved = await snapshotWith("Approval rules saved.");
  const fetchRules = async () => (await (await fetch(`${handle.url}/api/bots/${handle.botId}/approval-rules`)).json() as any).rules;
  const rules = await fetchRules();
  assert.equal(rules.tools["native:Read"], "always_allow"); assert.equal(rules.tools["mcp:mail:send_email"], "require_approval");
  assert.equal(rules.categories["send-like"], "require_approval");
  await ui("click", "--name", "Close settings");
  const closeDeadline = Date.now() + 10_000;
  while (Object.values((await snapshot()).refs).some((ref: any) => ref.name === "Close settings")) {
    if (Date.now() > closeDeadline) throw new Error("Settings did not close");
    await delay(100);
  }
  await open();
  const reopened = await ui("eval", "--js", "Array.from(document.querySelectorAll('textarea')).map(e => e.value)");
  assert.match(JSON.stringify(reopened), /mcp:mail:send_email/);
  await fill("Require approval tools", "native:Read"); await ui("click", "--name", "Save approval rules");
  const invalid = await snapshot(); assert.match(JSON.stringify(invalid), /cannot be in both lists/);
  assert.deepEqual(await fetchRules(), rules);
  await fill("Require approval tools", "mcp:mail:send_email");
  await ui("eval", "--js", "document.querySelector('textarea[aria-label=\"Always allow tools\"]').closest('.rounded-xl').scrollIntoView({block:'start'}); true");
  const screenshot = await ui("screenshot", "--out", ".omb-scratch/verify-evidence/approval-rules/settings.png");
  const console_ = await ui("console");
  assert.ok(!JSON.stringify(console_).includes('"type":"error"'), "browser console errors");
  const evidence = { fixture: { url: handle.url, logPath: handle.logPath }, saved, reopened, invalid, rules, screenshot, console: console_ };
  const evidencePath = resolve(".omb-scratch/verify-evidence/approval-rules/ui.json");
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(`PASS settings save, persistence and invalid overlap; evidence: ${evidencePath}`);
  return evidence;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "--ui") await verifyApprovalRulesUi(process.argv[3]); else await verifyApprovalRules();
}
