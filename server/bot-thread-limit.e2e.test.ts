import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";

/** A per-bot parallel-thread override against an isolated scripted server.
 * Gated turns hold a thread open so the limit can be hit on purpose. */
async function fixture(test: (f: any) => Promise<void>) {
  const session = await launchVerificationServer({ ...process.env }, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  try {
    const gate = join(session.info.dataDir, "release-turns");
    const plan: Record<string, unknown> = {};
    const savePlan = () => writeFileSync(join(session.info.dataDir, "room-plan.json"), JSON.stringify(plan));
    const newBot = async (name: string) => {
      const bot = (await cli("new-bot", "--name", name, "--section", "Engineering")).bot;
      plan[bot.id] = { gateFile: gate, reply: "done" };
      savePlan();
      return bot;
    };
    const task = async (bot: any, title: string) => (await api(`/api/bots/${bot.id}/tasks`, { title })).task.threadId as string;
    // Guarded sends refuse rather than queue when a bot has no free slot, so
    // an accepted send is a started turn and a refusal is the limit.
    const send = (bot: any, threadId: string) => api(`/api/bots/${bot.id}/messages/guarded`, { text: `work on ${threadId}`, threadId, sendId: randomUUID(), expectedActiveLeafId: null });
    const bots = async () => (await api("/api/bots?messages=0")).bots;
    const stored = async (id: string) => (await bots()).find((bot: any) => bot.id === id);
    await test({ session, cli, api, gate, newBot, task, send, stored });
  } finally { await session.close(); }
}

it("accepts a per-bot parallel-thread limit of one to ten and nothing else", () => fixture(async f => {
  const bot = await f.newBot("Limited");
  for (const bad of [0, -1, 11, 1.5, "3", true, [], {}]) {
    await expect(f.api(`/api/bots/${bot.id}`, { maxConcurrentThreads: bad }, "PATCH"), JSON.stringify(bad)).rejects.toThrow(/\(400\).*maxConcurrentThreads/);
  }
  expect((await f.stored(bot.id)).maxConcurrentThreads).toBeUndefined();
  for (const good of [1, 5, 10]) {
    const saved = await f.api(`/api/bots/${bot.id}`, { maxConcurrentThreads: good }, "PATCH");
    expect(saved.bot.maxConcurrentThreads).toBe(good);
    expect((await f.stored(bot.id)).maxConcurrentThreads).toBe(good);
  }
  // null returns the bot to the workspace default
  const cleared = await f.api(`/api/bots/${bot.id}`, { maxConcurrentThreads: null }, "PATCH");
  expect(cleared.bot.maxConcurrentThreads).toBeUndefined();
  expect((await f.stored(bot.id)).maxConcurrentThreads).toBeUndefined();
}), 60_000);

it("caps parallel starts at the bot's own limit, falling back to the global default when unset", () => fixture(async f => {
  await f.api("/api/config", { threads: { maxConcurrentPerBot: 2 } }, "PATCH");
  const own = await f.newBot("Own limit");
  const inherits = await f.newBot("Inherits");
  await f.api(`/api/bots/${own.id}`, { maxConcurrentThreads: 1 }, "PATCH");
  const [o1, o2] = [await f.task(own, "first"), await f.task(own, "second")];
  const [i1, i2, i3] = [await f.task(inherits, "first"), await f.task(inherits, "second"), await f.task(inherits, "third")];
  const refused = async (promise: Promise<unknown>) => {
    const caught = await promise.then(() => "accepted", (error: Error) => error.message);
    expect(caught).toMatch(/\(409\).*guarded_busy/);
  };

  // override 1 beats a global of 2: the second parallel start is refused
  await f.send(own, o1);
  await refused(f.send(own, o2));

  // no override: the global 2 applies
  await f.send(inherits, i1);
  await f.send(inherits, i2);
  await refused(f.send(inherits, i3));

  // the override can also raise a bot above the global default, live
  await f.api(`/api/bots/${own.id}`, { maxConcurrentThreads: 2 }, "PATCH");
  await f.send(own, o2);
  await f.api(`/api/bots/${inherits.id}`, { maxConcurrentThreads: 3 }, "PATCH");
  await f.send(inherits, i3);

  // clearing the override returns to the global value: 2 running already fills it
  await f.api(`/api/bots/${own.id}`, { maxConcurrentThreads: null }, "PATCH");
  const o3 = await f.task(own, "third");
  await refused(f.send(own, o3));

  writeFileSync(f.gate, "release");
}), 90_000);
