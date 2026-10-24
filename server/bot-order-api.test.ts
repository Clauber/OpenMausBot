import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";

describe("bot roster order through an isolated server", () => {
  let fixture: VerificationServer;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  beforeAll(async () => { fixture = await launchVerificationServer(); });
  afterAll(async () => { await fixture?.close(); });
  it("saves the whole permutation without changing bot threads and returns it to another client", async () => {
    for (const name of ["Atlas", "Scout", "Pepper"]) expect((await api("POST", "/api/bots", { name })).status).toBe(201);
    const before = (await api("GET", "/api/bots")).body.bots;
    const botIds = before.map((bot: any) => bot.id).reverse();
    const response = await api("PATCH", "/api/bots/order", { botIds });
    expect(response.status).toBe(200);
    expect(response.body.botIds).toEqual(botIds);
    expect(JSON.parse(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8")).map((bot: any) => bot.id)).toEqual(botIds);
    const after = (await api("GET", "/api/bots")).body.bots;
    expect(after.map((bot: any) => bot.id)).toEqual(botIds);
    for (const bot of after) expect(bot.threadId).toBe(before.find((entry: any) => entry.id === bot.id).threadId);
    for (const invalid of [botIds.slice(1), [...botIds, botIds[0]], botIds.map(() => "missing")]) {
      expect((await api("PATCH", "/api/bots/order", { botIds: invalid })).status).toBe(400);
    }
    expect((await api("PATCH", "/api/bots/order", { botIds, extra: true })).status).toBe(400);
    expect((await api("GET", "/api/bots")).body.bots.map((bot: any) => bot.id)).toEqual(botIds);
  });
});
