// Space isolation in an isolated fixture: two spaces, the chokepoint's 403,
// same-space chat through the fake engine, filtered pages and bot lists.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { removeTempDir } from "../server/testing/cleanup.ts";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";

async function until<T>(read: () => T | Promise<T>, timeout = 20_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { const value = await read(); if (value) return value; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("fixture condition timed out");
}

export async function verifySpaces() {
  const gates = mkdtempSync(join(tmpdir(), "omb-spaces-gates-")), gate = join(gates, "finish");
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate });
  const evidence: unknown[] = [];
  const api = async (method: string, path: string, body?: unknown, status = 200, headers: Record<string, string> = {}) => {
    const response = await fetch(fixture.info.url + path, { method,
      headers: { "content-type": "application/json", origin: fixture.info.url, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any;
    evidence.push({ method, path, scope: headers["x-omb-space"], body, status: response.status, result });
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result)}`);
    return result;
  };
  const control = async (...args: string[]) => {
    const result = await runControlOmb([...args, "--url", fixture.info.url]) as any;
    evidence.push({ command: args, result }); return result;
  };
  const evidencePath = `${fixture.info.logPath}.spaces.json`;
  try {
    const initial = await api("GET", "/api/spaces");
    assert.deepEqual(initial.spaces.map((space: any) => space.id), ["personal"]);
    const personal = "personal";
    const botA = (await api("POST", "/api/bots", { name: "Space A bot" }, 201)).bot;
    const botB = (await api("POST", "/api/bots", { name: "Space B bot" }, 201)).bot;
    const work = (await api("POST", "/api/spaces", { name: "Work" }, 201)).space;
    await api("PUT", "/api/spaces/assign", { kind: "bot", id: botB.id, spaceId: work.id });
    await api("PUT", "/api/spaces/assign", { kind: "bot", id: "no-such-bot", spaceId: work.id }, 404);
    const pageA = (await api("POST", "/api/pages", { revision: 0, title: "Personal notes", content: "alpha" }, 201)).page;
    const pageB = (await api("POST", "/api/pages", { revision: 0, title: "Work notes", content: "beta", spaceId: work.id }, 201)).page;
    assert.equal(pageA.spaceId, personal);

    // Owner sees every space; a context scoped to Work sees only Work.
    const inWork = { "x-omb-space": work.id };
    assert.ok((await api("GET", "/api/bots?messages=0")).bots.length >= 2);
    assert.deepEqual((await api("GET", "/api/bots?messages=0", undefined, 200, inWork)).bots.map((bot: any) => bot.id), [botB.id]);

    // The chokepoint: 403 with code space_isolation for every kind of entity reference.
    for (const [method, path, body] of [
      ["GET", `/api/threads/${botA.threadId}/messages`], ["POST", `/api/bots/${botA.id}/tasks`, {}], ["GET", `/api/pages/${pageA.id}`],
      ["GET", `/api/pages?spaceId=${personal}`], ["POST", `/api/pages/${pageA.id}/chat`, { revision: 1, botId: botB.id }],
    ] as const) {
      const refused = await api(method, path, body, 403, inWork);
      assert.equal(refused.code, "space_isolation", path);
      assert.equal(refused.space, personal);
    }
    await api("POST", "/api/spaces", { name: "Nope" }, 403, inWork);
    // Owner chat across spaces is not blocked (single-operator model), and the page chat itself is refused cross-space.
    const crossChat = await api("POST", `/api/pages/${pageA.id}/chat`, { revision: 1, botId: botB.id }, 403);
    assert.equal(crossChat.code, "space_isolation");

    // Entity-to-entity: A cannot reach B (roster, @mention, delegation) until the pair is allowlisted.
    await control("send", "--bot", botA.id, "--task", botA.threadId, "--text", "Which teammates can you reach?");
    const dump = await until(() => JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")));
    const token = dump.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
    assert.ok(token);
    const peers = async () => (await api("GET", "/api/internal/agents", undefined, 200, { authorization: `Bearer ${token}` })).bots.map((bot: any) => bot.id);
    assert.ok(!(await peers()).includes(botB.id), "bot in another space is not a reachable peer");
    await api("POST", "/api/spaces/allowlist", { from: personal, to: work.id });
    assert.ok((await peers()).includes(botB.id), "allowlisted pair is reachable");
    await api("DELETE", "/api/spaces/allowlist", { from: personal, to: work.id });
    assert.ok(!(await peers()).includes(botB.id));
    writeFileSync(gate, "finish");
    await until(async () => !(await api("GET", "/api/bots?messages=0")).bots.find((b: any) => b.id === botA.id).busy);

    // Same-space flows work end to end through the fake engine.
    await api("GET", `/api/threads/${botB.threadId}/messages`, undefined, 200, inWork);
    await control("send", "--bot", botB.id, "--task", botB.threadId, "--text", "Hello from the Work space");
    await control("wait", "--bot", botB.id, "--task", botB.threadId, "--timeout", "20");
    const reply = await api("GET", `/api/threads/${botB.threadId}/messages`, undefined, 200, inWork);
    assert.ok(reply.messages.some((message: any) => message.role === "bot" && message.kind === "text"), "bot reply through the fake engine");
    const pagesInWork = await api("GET", "/api/pages", undefined, 200, inWork);
    assert.deepEqual(pagesInWork.pages.map((page: any) => page.id), [pageB.id]);
    assert.deepEqual((await api("GET", "/api/pages")).pages.map((page: any) => page.id), [pageA.id]);
    await api("GET", `/api/pages/${pageB.id}`, undefined, 200, inWork);
    const sameChat = await api("POST", `/api/pages/${pageB.id}/chat`, { revision: 1, botId: botB.id }, 201, inWork);
    assert.equal(sameChat.botId, botB.id);

    // Spaces delete only when empty; the default space never.
    await api("DELETE", `/api/spaces/${work.id}`, undefined, 409);
    await api("DELETE", `/api/spaces/${personal}`, undefined, 409);
    const scratch = (await api("POST", "/api/spaces", { name: "Scratch" }, 201)).space;
    await api("PATCH", `/api/spaces/${scratch.id}`, { name: "Scratch 2" });
    await api("DELETE", `/api/spaces/${scratch.id}`);
    return { evidencePath, logPath: fixture.info.logPath, url: fixture.info.url, checks: "spaces CRUD, assignment, 403 space_isolation, same-space chat, page and bot list filtering, peer isolation, allowlist, delete-when-empty" };
  } finally {
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    await fixture.close(); await removeTempDir(gates);
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  console.log(JSON.stringify(await verifySpaces()));
}
