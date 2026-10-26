import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { launchRestartableServer } from "./testing/restartable-server.ts";
import { SessionRegistry } from "./sessions.ts";

const botSchema = z.object({ id: z.string(), name: z.string(), threadId: z.string(), activeTaskId: z.string().optional(),
  chiefOfStaff: z.boolean().optional(), section: z.string().nullable().optional(), approvalMode: z.string().optional(), soul: z.string().optional(),
  tasks: z.array(z.object({ threadId: z.string(), busy: z.boolean().optional(), approvalMode: z.string().optional() })).optional() });

it("manages General bots through injected tools, keeps deletion confirmed, and audits explicit permission changes", async () => {
  const fixture = await launchRestartableServer({ scripted: true });
  const evidence: unknown[] = [];
  const request = async (method: string, path: string, body?: unknown, status = 200, token?: string) => {
    const response = await fetch(fixture.url + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
    const result: unknown = await response.json();
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(status);
    evidence.push({ method, path, status: response.status, result });
    return result;
  };
  const create = async (name: string, section?: string) => z.object({ bot: botSchema }).parse(await request("POST", "/api/bots", { name, section }, 201)).bot;
  const bots = async () => z.object({ bots: z.array(botSchema) }).parse(await request("GET", "/api/bots?messages=0")).bots;
  const steps: Record<string, { turns: unknown[] }> = {};
  async function run(bot: z.infer<typeof botSchema>, calls: Array<{ tool: string; arguments: unknown; expectError?: boolean }>, reply: string, resumes: unknown[] = []) {
    (steps[bot.id] ??= { turns: [] }).turns.push({ steps: calls, reply }, ...resumes);
    writeFileSync(fixture.planPath, JSON.stringify(steps));
    await request("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `Run fixture: ${reply}` }, 202);
    await expect.poll(async () => {
      const result = z.object({ messages: z.array(z.object({ role: z.string(), text: z.string().optional(), turnSucceeded: z.boolean().optional() }).passthrough()) }).parse(await request("GET", `/api/threads/${bot.threadId}/messages?limit=30`));
      if (result.messages.slice(-3).some(message => message.turnSucceeded === false)) throw new Error(`Provider turn failed: ${JSON.stringify(result.messages.slice(-3))}`);
      return result.messages.some(message => message.role === "bot" && message.text === reply);
    }, { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => (await bots()).find(item => item.id === bot.id)?.tasks?.some(task => task.busy), { timeout: 15_000 }).toBe(false);
  }
  try {
    const master = await create("Fixture Master", "Support");
    await request("PATCH", `/api/bots/${master.id}`, { chiefOfStaff: true });
    const ordinary = await create("Ordinary Chief", "Other");
    await request("PATCH", `/api/bots/${ordinary.id}`, { chiefOfStaff: true });
    const pam = await create("Pam Fixture");
    const michael = await create("Michael Fixture");
    await request("PATCH", `/api/bots/${michael.id}`, { chiefOfStaff: true });
    const watcher = await create("Watcher Fixture", "Support");
    const cardBot = await create("Card Fixture");
    await fixture.stop();
    const stored = z.array(z.record(z.string(), z.unknown())).parse(JSON.parse(readFileSync(join(fixture.dataDir, "bots.json"), "utf8")));
    for (const bot of stored) {
      bot.approvalMode = bot.id === master.id || bot.id === ordinary.id ? "full" : "ask";
      bot.autoApprove = false;
      bot.tasks = z.array(z.record(z.string(), z.unknown())).parse(bot.tasks).map(task => ({ ...task, approvalMode: bot.approvalMode, autoApprove: false }));
    }
    writeFileSync(join(fixture.dataDir, "bots.json"), JSON.stringify(stored));
    const configPath = join(fixture.dataDir, "config.json");
    const config = z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(configPath, "utf8")));
    config.profile = { email: "owner@example.com" };
    config.signIn = { admins: ["owner@example.com"] };
    writeFileSync(configPath, JSON.stringify(config));
    const sessions = new SessionRegistry({ file: join(fixture.dataDir, "sessions.json"), emailScopes: email => email === "owner@example.com" ? ["admin", "client"] : null });
    const owner = sessions.issue({ label: "Fixture owner", email: "owner@example.com", scopes: ["admin", "client"] }).token;
    sessions.close();
    await fixture.start();
    await request("PUT", "/api/fleet/master-chief", { botId: master.id }, 403);
    await request("PUT", "/api/fleet/master-chief", { botId: master.id }, 200, owner);
    await run(ordinary, [{ tool: "propose_profile", arguments: { for_bot_id: pam.id, soul: "unauthorized", reason: "Outside ordinary scope" }, expectError: true }], "ordinary denied");
    // Legion's scripted engine cannot raise a permission card; a gated turn holds the target busy instead.
    steps[pam.id] = { turns: [{ gateFile: join(fixture.dataDir, "pam-never-released.gate"), reply: "approval completed" }] };
    writeFileSync(fixture.planPath, JSON.stringify(steps));
    await request("POST", `/api/bots/${pam.id}/messages`, { threadId: pam.threadId, text: "Hold this turn" }, 202);
    await expect.poll(async () => (await bots()).find(bot => bot.id === pam.id)?.tasks?.some(task => task.busy), { timeout: 30_000 }).toBe(true);
    expect((await bots()).find(bot => bot.id === pam.id)?.tasks?.some(task => task.busy)).toBe(true);
    await run(master, [{ tool: "set_bot_approval", arguments: { target_bot_id: pam.id, approval_mode: "full", apply_to_all_threads: true }, expectError: true }], "busy widening refused");
    await run(master, [{ tool: "set_bot_approval", arguments: { target_bot_id: pam.id, approval_mode: "ask", apply_to_all_threads: true } }], "busy target stopped");
    await expect.poll(async () => (await bots()).find(bot => bot.id === pam.id)?.tasks?.some(task => task.busy), { timeout: 15_000 }).toBe(false);
    const stopped = z.object({ messages: z.array(z.object({ text: z.string().optional() })) }).parse(await request("GET", `/api/threads/${pam.threadId}/messages?limit=30`));
    expect(stopped.messages.some(message => message.text === "approval completed")).toBe(false);
    await run(master, [
      { tool: "propose_profile", arguments: { for_bot_id: pam.id, soul: "Stay quiet after a successful check.", reason: "Fix standing instructions" } },
      { tool: "set_bot_approval", arguments: { target_bot_id: watcher.id, approval_mode: "full", apply_to_all_threads: true } },
      { tool: "set_bot_approval", arguments: { target_bot_id: master.id, approval_mode: "ask" }, expectError: true },
    ], "master changes applied");
    expect((await bots()).find(bot => bot.id === pam.id)?.soul).toBe("Stay quiet after a successful check.");
    expect((await bots()).find(bot => bot.id === watcher.id)?.approvalMode).toBe("full");
    expect((await bots()).find(bot => bot.id === pam.id)?.approvalMode).toBe("ask");
    steps[pam.id]!.turns.push({ reply: "Pam received direct work" });
    await run(master, [{ tool: "coordinate_bots", arguments: { bot_ids: [pam.id], message: "Acknowledge this direct handoff.", reply: "none" } }], "General direct work dispatched");
    expect((await bots()).find(bot => bot.id === pam.id)?.approvalMode).toBe("ask");
    await expect.poll(async () => (await bots()).find(bot => bot.id === pam.id)?.tasks?.some(task => task.busy), { timeout: 15_000 }).toBe(true);
    await run(master, [{ tool: "set_bot_approval", arguments: { target_bot_id: pam.id, approval_mode: "ask", apply_to_all_threads: true } }], "direct Ask target stopped");
    await expect.poll(async () => (await bots()).find(bot => bot.id === pam.id)?.tasks?.some(task => task.busy), { timeout: 15_000 }).toBe(false);
    // A real supported proposal card (not a provider-native permission card): an Ask turn left waiting on owner review.
    const cardPage = z.object({ messages: z.array(z.object({ card: z.object({ requestId: z.string().optional(), answered: z.unknown().optional(), dismissed: z.unknown().optional() }).passthrough().optional() })) });
    const pendingCards = async () => cardPage.parse(await request("GET", `/api/threads/${cardBot.threadId}/messages?limit=50`)).messages
      .filter(message => message.card && !message.card.answered && !message.card.dismissed);
    await request("PATCH", `/api/bots/${cardBot.id}`, { approvalRules: { tools: { "mcp:agents:propose_profile": "require_approval" } } }, 200, owner);
    steps[cardBot.id] = { turns: [] };
    steps[cardBot.id]!.turns.push({ steps: [{ tool: "propose_profile", arguments: { title: "Pending Ask title", reason: "Ask task requires review" } }], reply: "proposal awaiting review" });
    writeFileSync(fixture.planPath, JSON.stringify(steps));
    await request("POST", `/api/bots/${cardBot.id}/messages`, { threadId: cardBot.threadId, text: "Propose a title for review" }, 202);
    await expect.poll(async () => (await pendingCards()).length, { timeout: 30_000 }).toBe(1);
    const cardRequestId = (await pendingCards())[0]!.card!.requestId;
    const cardTurns = () => readFileSync(fixture.planPath + ".evidence.jsonl", "utf8").split("\n").filter(Boolean)
      .filter(line => z.object({ botId: z.string() }).passthrough().parse(JSON.parse(line)).botId === cardBot.id).length;
    // Settle first when the turn can end with the card still pending; a turn held on the card stays busy.
    await expect.poll(async () => (await bots()).find(bot => bot.id === cardBot.id)?.tasks?.some(task => task.busy), { timeout: 15_000 }).toBe(false).catch(() => undefined);
    const cardTurnsBefore = cardTurns();
    const busyWithCard = Boolean((await bots()).find(bot => bot.id === cardBot.id)?.tasks?.some(task => task.busy));
    evidence.push({ pendingProposalCard: { requestId: cardRequestId, busy: busyWithCard } });
    await run(master, [{ tool: "set_bot_approval", arguments: { target_bot_id: cardBot.id, approval_mode: "full", apply_to_all_threads: true }, expectError: busyWithCard }],
      busyWithCard ? "pending-card widening refused" : "pending-card widening applied");
    expect((await bots()).find(bot => bot.id === cardBot.id)?.approvalMode).toBe(busyWithCard ? "ask" : "full");
    expect((await pendingCards()).map(message => message.card!.requestId)).toEqual([cardRequestId]);
    expect(cardTurns()).toBe(cardTurnsBefore);
    if (!busyWithCard) await run(master, [{ tool: "set_bot_approval", arguments: { target_bot_id: cardBot.id, approval_mode: "ask", apply_to_all_threads: true } }], "pending-card target restored to Ask");
    expect((await bots()).find(bot => bot.id === cardBot.id)?.approvalMode).toBe("ask");
    await run(master, [{ tool: "create_room", arguments: { name: "Fleet room fixture", member_bot_ids: [watcher.id, michael.id], bulletin: "Cross-section work" } }], "room created");
    const roomList = z.object({ groups: z.array(z.object({ id: z.string(), name: z.string(), threadId: z.string() })) }).parse(await request("GET", "/api/bots?messages=0"));
    const room = roomList.groups.find(group => group.name === "Fleet room fixture")!;
    await run(master, [{ tool: "authorize_room_task", arguments: { room_id: room.id, title: "Authorized fleet task" } }], "room authorized");
    steps[michael.id] = { turns: [{ reply: "Michael contributed" }] };
    steps[watcher.id] = { turns: [{ reply: "Watcher contributed" }] };
    await run(master, [{ tool: "coordinate_bots", arguments: { group_id: room.id, bot_ids: [michael.id, watcher.id], message: "Contribute one line to this room task.", reply: "none" } }], "room work dispatched", [{ reply: "room results reviewed" }]);
    const updatedRoom = z.object({ groups: z.array(z.object({ id: z.string(), threadId: z.string() })) }).parse(await request("GET", "/api/bots?messages=0")).groups.find(group => group.id === room.id)!;
    await expect.poll(async () => {
      const page = z.object({ messages: z.array(z.object({ role: z.string(), text: z.string().optional() })) }).parse(await request("GET", `/api/threads/${updatedRoom.threadId}/messages?limit=50`));
      return ["Michael contributed", "Watcher contributed"].every(text => page.messages.some(message => message.role === "bot" && message.text === text));
    }, { timeout: 30_000 }).toBe(true);
    expect((await bots()).find(bot => bot.id === michael.id)?.approvalMode).toBe("ask");
    const lateGate = join(fixture.dataDir, "michael-late.gate");
    steps[michael.id]!.turns.push({ gateFile: lateGate, reply: "Michael finished late" });
    await expect.poll(async () => {
      const result = z.object({ messages: z.array(z.object({ role: z.string(), text: z.string().optional() })) }).parse(await request("GET", `/api/threads/${master.threadId}/messages?limit=30`));
      return result.messages.some(message => message.role === "bot" && message.text === "room results reviewed");
    }, { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => (await bots()).find(bot => bot.id === master.id)?.tasks?.some(task => task.busy), { timeout: 15_000 }).toBe(false);
    const michaelThreads = new Set((await bots()).find(bot => bot.id === michael.id)?.tasks?.map(task => task.threadId));
    await run(master, [{ tool: "send_to_bot", arguments: { bot_id: michael.id, title: "Late fixture work", message: "Finish this after my turn ends." } }], "late work sent");
    await expect.poll(async () => (await bots()).find(bot => bot.id === michael.id)?.tasks?.some(task => task.busy), { timeout: 15_000 }).toBe(true);
    const auditSchema = z.object({ entries: z.array(z.object({ id: z.string(), actorBotId: z.string().nullable() })) });
    const beforeRelease = new Set(auditSchema.parse(await request("GET", "/api/fleet/audit", undefined, 200, owner)).entries.map(row => row.id));
    writeFileSync(lateGate, "release");
    const lateThread = (await bots()).find(bot => bot.id === michael.id)!.tasks!.find(task => !michaelThreads.has(task.threadId))!;
    await expect.poll(async () => {
      const result = z.object({ messages: z.array(z.object({ role: z.string(), text: z.string().optional(), turnSucceeded: z.boolean().optional() })) }).parse(await request("GET", `/api/threads/${lateThread.threadId}/messages?limit=30`));
      return result.messages.some(message => message.role === "bot" && message.text === "Michael finished late");
    }, { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => (await bots()).find(bot => bot.id === michael.id)?.tasks?.some(task => task.busy), { timeout: 15_000 }).toBe(false);
    const late = (await bots()).find(bot => bot.id === michael.id)!;
    expect(late.approvalMode).toBe("ask");
    expect(late.tasks!.find(task => task.threadId === lateThread.threadId)?.approvalMode ?? "ask").toBe("ask");
    const afterRelease = auditSchema.parse(await request("GET", "/api/fleet/audit", undefined, 200, owner)).entries.filter(row => !beforeRelease.has(row.id));
    expect(afterRelease.filter(row => row.actorBotId === master.id)).toEqual([]);
    await run(master, [{ tool: "propose_team_setup", arguments: { reason: "Repair sectionless Chief role", operations: [{ action: "update", botId: michael.id, fields: { chiefOfStaff: false } }] } }], "other Chief repaired");
    expect((await bots()).find(bot => bot.id === michael.id)?.chiefOfStaff).toBe(false);
    expect((await bots()).find(bot => bot.id === michael.id)?.section || null).toBeNull();
    await run(master, [{ tool: "propose_bot_deletion", arguments: { bot_id: pam.id, reason: "Confirm fixture deletion" } }], "deletion pending");
    expect((await bots()).some(bot => bot.id === pam.id)).toBe(true);
    const page = z.object({ messages: z.array(z.object({ card: z.object({ requestId: z.string().optional(), teamSetupRequest: z.unknown().optional() }).passthrough().optional() })) })
      .parse(await request("GET", `/api/threads/${master.threadId}/messages?limit=50`));
    const card = page.messages.findLast(message => message.card?.teamSetupRequest && !message.card.answered)?.card;
    expect(card?.requestId).toBeTruthy();
    await request("POST", `/api/threads/${master.threadId}/respond`, { requestId: card!.requestId, behavior: "allow" }, 403);
    await request("POST", `/api/threads/${master.threadId}/respond`, { requestId: card!.requestId, behavior: "allow" }, 200, owner);
    expect((await bots()).some(bot => bot.id === pam.id)).toBe(false);
    const duplicate = await request("POST", `/api/threads/${master.threadId}/respond`, { requestId: card!.requestId, behavior: "allow" }, 409, owner);
    expect(duplicate).toMatchObject({ code: "effect_replayed" });
    for (const decision of ["always_allow", "require_approval"] as const) {
      await expect.poll(async () => (await bots()).find(bot => bot.id === master.id)?.tasks?.some(task => task.busy), { timeout: 15_000 }).toBe(false);
      const target = await create(`Deletion ${decision}`);
      await request("PATCH", `/api/bots/${master.id}`, { approvalRules: { tools: { "mcp:agents:propose_bot_deletion": decision } } }, 200, owner);
      const pending = run(master, [{ tool: "propose_bot_deletion", arguments: { bot_id: target.id, reason: `Confirm ${decision} deletion` } }], `${decision} deletion pending`);
      const cards = async () => cardPage.parse(await request("GET", `/api/threads/${master.threadId}/messages?limit=50`)).messages
        .flatMap(message => message.card && !message.card.answered && !message.card.dismissed ? [message.card] : []);
      if (decision === "require_approval") {
        await expect.poll(async () => (await cards()).some(card => card.outboundRequest), { timeout: 15_000 }).toBe(true);
        const preliminary = (await cards()).find(card => card.outboundRequest)!;
        expect(preliminary.effectKey).toBeUndefined();
        await request("POST", `/api/threads/${master.threadId}/respond`, { requestId: preliminary.requestId, behavior: "allow" }, 200, owner);
      }
      await pending;
      expect((await bots()).some(bot => bot.id === target.id)).toBe(true);
      const confirmation = (await cards()).find(card => card.teamSetupRequest)!;
      expect(confirmation.effectKey).toEqual(expect.any(String));
      await request("POST", `/api/threads/${master.threadId}/respond`, { requestId: confirmation.requestId, behavior: "allow" }, 200, owner);
      expect((await bots()).some(bot => bot.id === target.id)).toBe(false);
    }
    const audit = z.object({ entries: z.array(z.object({ changes: z.array(z.object({ targetId: z.string(), after: z.unknown() })) })) })
      .parse(await request("GET", "/api/fleet/audit", undefined, 200, owner));
    expect(audit.entries.some(row => row.changes.some(change => change.targetId === pam.id && change.after === null))).toBe(true);
    expect(existsSync(fixture.planPath + ".evidence.jsonl")).toBe(true);
    writeFileSync(fixture.logPath + ".master-chief.json", JSON.stringify({ evidence, provider: readFileSync(fixture.planPath + ".evidence.jsonl", "utf8") }));
  } finally {
    writeFileSync(fixture.logPath + ".master-chief-debug.json", JSON.stringify({ evidence, provider: existsSync(fixture.planPath + ".evidence.jsonl") ? readFileSync(fixture.planPath + ".evidence.jsonl", "utf8") : "" }));
    await fixture.close();
  }
}, 120_000);
