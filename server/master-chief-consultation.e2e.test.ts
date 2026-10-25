import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { launchRestartableServer } from "./testing/restartable-server.ts";
import { SessionRegistry } from "./sessions.ts";
import { runControlOmb } from "../scripts/control-omb.ts";

const botSchema = z.object({ id: z.string(), name: z.string(), threadId: z.string() });
const nodeSchema = z.object({ id: z.string(), botId: z.string(), threadId: z.string(), groupId: z.string().optional(), parentId: z.string().optional(), status: z.string(), report: z.string().optional() }).passthrough();

async function consultation(test: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try { await test(f); } finally {
    writeFileSync(f.server.logPath + ".evidence.json", JSON.stringify({ url: f.server.url, nodes: f.nodes(), provider: f.evidence() }));
    await f.server.close();
  }
}

it("lets Dr. EggBot discover St. Paul's folders through its injected tools without elevating permissions", () => consultation(async f => {
  const project = join(f.server.dataDir, "mission-project");
  mkdirSync(project);
  writeFileSync(join(project, "mission.txt"), "Fixture mission file");
  await f.api(`/api/bots/${f.sender.id}`, { cwd: project }, "PATCH");
  f.plan[f.master.id] = { steps: [{ tool: "bot_folders", arguments: { bot_id: f.sender.id } }], reply: "MASTER_ANSWER: Prioritize outreach" };
  await f.start();
  await f.returned();
  const turn = f.evidence().trim().split("\n").map(line => z.object({ botId: z.string(), permissionMode: z.string(), evidence: z.array(z.unknown()) }).parse(JSON.parse(line)))
    .find(item => item.botId === f.master.id)!;
  expect(turn.permissionMode).toBe("default");
  const call = turn.evidence.map(item => z.object({ step: z.object({ tool: z.string().optional() }).passthrough().optional(), response: z.unknown().optional() }).passthrough().parse(item))
    .find(item => item.step?.tool === "bot_folders")!;
  const response = z.object({ result: z.object({ isError: z.boolean().optional(), content: z.array(z.object({ text: z.string() })) }) }).parse(call.response);
  expect(response.result.isError).toBeFalsy();
  expect(JSON.parse(response.result.content[0]!.text)).toMatchObject({ botId: f.sender.id,
    sharedBotFolder: join(f.server.dataDir, "workspaces", f.sender.id), otherThreadFiles: join(f.server.dataDir, "task-workspaces", f.sender.id), configuredProjectFolder: project });
  expect(readFileSync(join(project, "mission.txt"), "utf8")).toBe("Fixture mission file");
}), 60_000);

it("refuses folder discovery through injected tools after revocation and for malformed requests", () => consultation(async f => {
  f.plan[f.master.id] = { steps: [
    { tool: "bot_folders", arguments: { bot_id: f.sender.id, path: "/etc" }, expectError: true },
    { tool: "bot_folders", arguments: { bot_id: "missing" }, expectError: true },
  ], reply: "Malformed folder requests refused" };
  f.save();
  await f.api(`/api/bots/${f.master.id}/messages`, { threadId: f.master.threadId, text: "Check malformed requests" });
  await f.cli("wait", "--bot", f.master.id, "--task", f.master.threadId, "--timeout", "30");
  expect((await f.messages(f.master.threadId)).some(m => m.text === "Malformed folder requests refused")).toBe(true);
  await f.assign(null);
  f.plan[f.master.id] = { steps: [{ tool: "bot_folders", arguments: { bot_id: f.sender.id }, expectError: true }], reply: "Revoked folder request refused" };
  f.save();
  await f.api(`/api/bots/${f.master.id}/messages`, { threadId: f.master.threadId, text: "Check revoked folder access" });
  await f.cli("wait", "--bot", f.master.id, "--task", f.master.threadId, "--timeout", "30");
  expect((await f.messages(f.master.threadId)).some(m => m.text === "Revoked folder request refused")).toBe(true);
}), 60_000);

it("rechecks assignment after the person approves a pending question", () => consultation(async f => {
  await f.api(`/api/bots/${f.sender.id}`, { approvePeerComms: true }, "PATCH");
  f.plan[f.sender.id] = { steps: [{ expectError: true, arguments: { bot_ids: [f.master.id], message: "Check assignment at dispatch" } }], reply: "Revoked question refused" };
  await f.start();
  const pending = async () => z.array(z.object({ card: z.object({ requestId: z.string(), answered: z.unknown().optional(), dismissed: z.unknown().optional() }).optional() }).passthrough())
    .parse(await f.messages(f.sender.threadId)).find(m => m.card && !m.card.answered && !m.card.dismissed)?.card;
  await expect.poll(pending, { timeout: 15_000 }).toBeTruthy();
  await f.assign(null);
  await f.api(`/api/threads/${f.sender.threadId}/respond`, { requestId: (await pending())!.requestId, behavior: "allow" });
  await expect.poll(async () => (await f.messages(f.sender.threadId)).some(m => m.text === "Revoked question refused"), { timeout: 15_000 }).toBe(true);
  expect(f.nodes().filter(n => n.parentId)).toEqual([]);
  expect(await f.messages(f.master.threadId)).toEqual(f.initialMaster);
}), 60_000);

it("withholds a previously returned answer when replaying after assignment transfer", () => consultation(async f => {
  await f.start();
  await f.returned();
  f.plan[f.sender.id] = { reply: "Follow-up answered" };
  f.save();
  await f.api(`/api/bots/${f.sender.id}/messages`, { threadId: f.sender.threadId, text: "Review the earlier answer" });
  await expect.poll(async () => (await f.messages(f.sender.threadId)).some(m => m.text === "Follow-up answered"), { timeout: 15_000 }).toBe(true);
  const successor = z.object({ bot: botSchema }).parse(await f.api("/api/bots", { name: "Successor", section: "Succession" })).bot;
  await f.api(`/api/bots/${successor.id}`, { chiefOfStaff: true }, "PATCH");
  await f.assign(successor.id);
  const followup = z.object({ id: z.string() }).parse((await f.messages(f.sender.threadId)).reverse().find(m => m.role === "user"));
  f.plan[f.sender.id] = { expectContextIncludes: ["Teammate result withheld"], reply: "Access removed" };
  f.save();
  await f.api(`/api/bots/${f.sender.id}/messages/${followup.id}/edit`, { threadId: f.sender.threadId, text: "Review access after transfer" });
  await expect.poll(async () => (await f.messages(f.sender.threadId)).some(m => m.text === "Access removed"), { timeout: 15_000 }).toBe(true);
  const turns = f.evidence().trim().split("\n").map(line => z.object({ botId: z.string(), prompt: z.unknown(), system: z.string() }).parse(JSON.parse(line)));
  const latest = turns.filter(turn => turn.botId === f.sender.id).slice(-1)[0]!;
  expect(JSON.stringify({ system: latest.system, prompt: latest.prompt })).not.toContain("MASTER_ANSWER");
}), 60_000);

it("requires the person's peer approval before consulting the Master", () => consultation(async f => {
  await f.api(`/api/bots/${f.sender.id}`, { approvePeerComms: true }, "PATCH");
  f.plan[f.sender.id] = { steps: [{ expectError: true, arguments: { bot_ids: [f.master.id], message: "Ask only with permission" } }], reply: "Owner denied question" };
  await f.start();
  const pending = async () => z.array(z.object({ card: z.object({ requestId: z.string(), answered: z.unknown().optional(), dismissed: z.unknown().optional() }).optional() }).passthrough())
    .parse(await f.messages(f.sender.threadId)).find(m => m.card && !m.card.answered && !m.card.dismissed)?.card;
  await expect.poll(pending, { timeout: 15_000 }).toBeTruthy();
  expect(f.nodes()).toEqual([]);
  await f.api(`/api/threads/${f.sender.threadId}/respond`, { requestId: (await pending())!.requestId, behavior: "deny" });
  await expect.poll(async () => (await f.messages(f.sender.threadId)).some(m => m.text === "Owner denied question"), { timeout: 15_000 }).toBe(true);
  expect(f.nodes()).toEqual([]);
}), 60_000);

it("does not grant an ordinary Chief management or one-way messaging access to the Master", () => consultation(async f => {
  await f.api(`/api/bots/${f.sender.id}`, { chiefOfStaff: true }, "PATCH");
  f.plan[f.sender.id] = { steps: [
    { tool: "bot_folders", arguments: { bot_id: f.master.id }, expectError: true },
    { tool: "propose_profile", arguments: { for_bot_id: f.master.id, soul: "Unauthorized change", reason: "Consultation is not management" }, expectError: true },
    { tool: "send_to_bot", arguments: { bot_id: f.master.id, title: "Unauthorized send", message: "Do not widen legacy access" }, expectError: true },
  ], reply: "Management and send refused" };
  await f.start();
  await expect.poll(async () => (await f.messages(f.sender.threadId)).some(m => m.text === "Management and send refused"), { timeout: 15_000 }).toBe(true);
  expect(f.nodes()).toEqual([]);
  expect(await f.messages(f.master.threadId)).toEqual(f.initialMaster);
}), 60_000);

it("keeps ancestor-loop protection when the Master tries to question the originating bot", () => consultation(async f => {
  f.plan[f.master.id] = { steps: [{ expectError: true, arguments: { bot_ids: [f.sender.id], message: "Do not recurse into the requester" } }], reply: "MASTER_ANSWER: Prioritize outreach" };
  await f.start();
  await f.returned();
  expect(f.nodes().filter(n => n.parentId)).toHaveLength(1);
  expect(f.evidence()).toMatch(/ancestor|cycle|loop/i);
}), 60_000);

async function setup() {
  const server = await launchRestartableServer({ scripted: true });
  const api = async (path: string, body?: unknown, method = "POST", token?: string) => {
    const response = await fetch(server.url + path, { method: body === undefined ? "GET" : method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(15_000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result: unknown = await response.json();
    expect(response.ok, `${path}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  };
  try {
    const create = async (name: string, section: string) => z.object({ bot: botSchema }).parse(await api("/api/bots", { name, section })).bot;
    const sender = await create("St. Paul", "Mission");
    const master = await create("Dr. EggBot", "Leadership");
    await api(`/api/bots/${master.id}`, { chiefOfStaff: true }, "PATCH");
    await server.stop();
    const configPath = join(server.dataDir, "config.json");
    const config = z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(configPath, "utf8")));
    config.profile = { email: "owner@example.com" };
    config.signIn = { admins: ["owner@example.com"] };
    writeFileSync(configPath, JSON.stringify(config));
    const sessions = new SessionRegistry({ file: join(server.dataDir, "sessions.json"), emailScopes: () => ["admin", "client"] });
    const owner = sessions.issue({ label: "Fixture owner", email: "owner@example.com", scopes: ["admin", "client"] }).token;
    sessions.close();
    await server.start();
    const assign = (botId: string | null) => api("/api/fleet/master-chief", { botId }, "PUT", owner);
    await assign(master.id);
    const plan: Record<string, unknown> = {
      [sender.id]: { turns: [
        { steps: [{ tool: "list_bots", arguments: {} }, { arguments: { bot_ids: ["Dr. EggBot"], message: "Which mission should we prioritize?" } }], reply: "Question sent" },
        { expectContextIncludes: ["MASTER_ANSWER: Prioritize outreach"], reply: "Prioritize the outreach mission" },
      ] },
      [master.id]: { reply: "MASTER_ANSWER: Prioritize outreach" },
    };
    const save = () => writeFileSync(server.planPath, JSON.stringify(plan));
    const nodes = () => { const file = join(server.dataDir, "room-handoffs.json"); return existsSync(file) ? z.array(nodeSchema).parse(JSON.parse(readFileSync(file, "utf8"))) : []; };
    const messages = async (threadId: string) => z.object({ messages: z.array(z.object({ text: z.string().optional(), role: z.string() }).passthrough()) }).parse(await api(`/api/threads/${threadId}/messages`)).messages;
    const initialMaster = await messages(master.threadId);
    const initialSender = await messages(sender.threadId);
    const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: server.url } });
    const start = async () => { save(); await api(`/api/bots/${sender.id}/messages`, { threadId: sender.threadId, text: "Ask Dr. EggBot which mission to prioritize." }); };
    const returned = async (threadId = sender.threadId) => expect.poll(async () => (await messages(threadId)).some(m => m.text === "Prioritize the outreach mission"), { timeout: 25_000 }).toBe(true);
    const evidence = () => existsSync(server.planPath + ".evidence.jsonl") ? readFileSync(server.planPath + ".evidence.jsonl", "utf8") : "";
    return { server, api, sender, master, assign, plan, save, nodes, messages, initialMaster, initialSender, cli, start, returned, evidence };
  } catch (error) { await server.close(); throw error; }
}

it("returns a room-origin question without adding the Master to the room", () => consultation(async f => {
  const created = z.object({ group: z.object({ id: z.string(), threadId: z.string() }) }).parse(await f.api("/api/groups", { name: "Mission planning", memberIds: [f.sender.id], setup: { bulletin: "Mission questions", defaultResponder: { kind: "member", botId: f.sender.id } } }));
  f.save();
  await f.cli("send-channel", "--channel", created.group.id, "--text", "@St. Paul Ask Dr. EggBot which mission to prioritize.");
  await f.returned(created.group.threadId);
  const child = f.nodes().find(n => n.parentId);
  expect(child).toMatchObject({ botId: f.master.id, status: "completed" });
  expect(child?.groupId).toBeUndefined();
  expect(f.nodes().find(n => !n.parentId)).toMatchObject({ groupId: created.group.id, threadId: created.group.threadId });
  expect(await f.messages(f.sender.threadId)).toEqual(f.initialSender);
}), 60_000);

it("pins the reply while the person selects another sender conversation", () => consultation(async f => {
  const gate = join(f.server.dataDir, "master-answer.gate");
  f.plan[f.master.id] = { gateFile: gate, reply: "MASTER_ANSWER: Prioritize outreach" };
  await f.start();
  await expect.poll(() => f.nodes().find(n => n.parentId)?.status, { timeout: 15_000 }).toBe("running");
  const other = z.object({ task: z.object({ threadId: z.string() }) }).parse(await f.api(`/api/bots/${f.sender.id}/tasks`, { title: "Unrelated conversation" }));
  writeFileSync(gate, "answer now");
  await f.returned();
  expect(await f.messages(other.task.threadId)).toEqual([]);
}), 60_000);

it("withholds the answer after assignment revocation", () => consultation(async f => {
  const gate = join(f.server.dataDir, "revoked-answer.gate");
  f.plan[f.master.id] = { gateFile: gate, reply: "REVOKED_MASTER_SECRET" };
  f.plan[f.sender.id] = { steps: [{ arguments: { bot_ids: [f.master.id], message: "Ask before revocation" } }], reply: "Question sent", resumeReply: "Result unavailable" };
  await f.start();
  await expect.poll(() => f.nodes().find(n => n.parentId)?.status, { timeout: 15_000 }).toBe("running");
  await f.assign(null);
  writeFileSync(gate, "finish after revocation");
  await expect.poll(async () => (await f.messages(f.sender.threadId)).some(m => m.text === "Result unavailable"), { timeout: 25_000 }).toBe(true);
  expect(JSON.stringify(await f.messages(f.sender.threadId))).not.toContain("REVOKED_MASTER_SECRET");
  const turns = f.evidence().trim().split("\n").map(line => z.object({ botId: z.string(), resumed: z.boolean(), prompt: z.unknown() }).parse(JSON.parse(line)));
  expect(JSON.stringify(turns.filter(turn => turn.botId === f.sender.id && turn.resumed))).not.toContain("REVOKED_MASTER_SECRET");
}), 60_000);

it.each(["peers", "audience", "explicit room"])("refuses a Master question blocked by %s", constraint => consultation(async f => {
  let groupId: string | undefined;
  if (constraint === "peers") await f.api(`/api/bots/${f.sender.id}`, { peers: [] }, "PATCH");
  if (constraint === "audience") await f.api(`/api/bots/${f.master.id}`, { visibility: "admins" }, "PATCH");
  if (constraint === "explicit room") {
    const created = z.object({ group: z.object({ id: z.string() }) }).parse(await f.api("/api/groups", { name: "Master private room", memberIds: [f.master.id], setup: { bulletin: "Private work", defaultResponder: { kind: "member", botId: f.master.id } } }));
    groupId = created.group.id;
  }
  f.plan[f.sender.id] = { steps: [{ expectError: true, arguments: { group_id: groupId, bot_ids: [f.master.id], message: "Do not cross this boundary" } }], reply: "Question refused" };
  await f.start();
  await expect.poll(async () => (await f.messages(f.sender.threadId)).some(m => m.text === "Question refused"), { timeout: 25_000 }).toBe(true);
  expect(f.nodes()).toEqual([]);
  expect(await f.messages(f.master.threadId)).toEqual(f.initialMaster);
}), 60_000);

it("lets St. Paul discover Dr. EggBot by name and receive the answer in the original thread", () => consultation(async f => {
  await f.start();
  await f.returned();
  expect(f.nodes().filter(n => n.parentId)).toEqual([expect.objectContaining({ botId: f.master.id, status: "completed" })]);
  const turn = f.evidence().trim().split("\n").map(line => z.object({ botId: z.string(), evidence: z.array(z.unknown()) }).parse(JSON.parse(line)))
    .find(item => item.botId === f.sender.id)!;
  const call = turn.evidence.map(item => z.object({ step: z.object({ tool: z.string().optional() }).passthrough().optional(), response: z.unknown().optional() }).passthrough().parse(item))
    .find(item => item.step?.tool === "list_bots")!;
  const reply = z.object({ result: z.object({ content: z.array(z.object({ text: z.string() })) }) }).parse(call.response);
  expect(reply.result.content[0]?.text).toContain("Dr. EggBot — Master Chief of Staff");
  const targets = z.object({ result: z.object({ content: z.array(z.object({ text: z.string() })) }) }).parse(turn.evidence[1]);
  expect(z.object({ bots: z.array(z.object({ id: z.string(), masterChiefOfStaff: z.boolean() })) }).parse(JSON.parse(targets.result.content[0]!.text)).bots)
    .toContainEqual({ id: f.master.id, masterChiefOfStaff: true });
  expect(f.evidence()).toContain("MASTER_ANSWER: Prioritize outreach");
  expect(await f.messages(f.master.threadId)).toEqual(f.initialMaster);
}), 60_000);
