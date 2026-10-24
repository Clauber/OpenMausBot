import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { z } from "zod";
import { grokExportToPackage, parseGrokExport } from "../shared/grok-import.ts";

it("imports a Grok export through the real API with skills disabled and routines paused", async () => {
  const fixture = await launchVerificationServer();
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    expect(await call("/api/team-library/cursor")).toEqual({ status: 200, body: { signedIn: false, waiting: false } });
    expect((await call("/api/team-library/grok", {})).status).toBe(400);
    expect((await call("/api/team-library/grok", { url: "https://example.com/bot/foreign" })).status).toBe(400);
    const signIn = await call("/api/team-library/cursor/sign-in", {});
    expect(signIn.status).toBe(200);
    expect(signIn.body).toMatchObject({ url: expect.stringMatching(/^https:\/\/cursor\.com\//) });
    expect(await call("/api/team-library/cursor/sign-out", {})).toEqual({ status: 200, body: { signedIn: false, waiting: false } });
    const { document } = grokExportToPackage(parseGrokExport({
      format: "openmaus.grok/1", name: "Fixture Eggbot", instructions: "Review eggs. Ask before acting.",
      skills: [{ name: "egg-review", description: "Review eggs.", instructions: "Check the shell." }],
      memories: ["Only use example.com for test accounts."],
      routines: [{ name: "Morning review", schedule: "0 9 * * *", prompt: "Review the eggs." }],
    }), { timeZone: "UTC" });
    const imported = await call("/api/teams/import?mode=add", document);
    expect(imported.status).toBe(201);
    const parsed = z.object({ bots: z.array(z.looseObject({ id: z.string(), section: z.string() })).length(1), routines: z.array(z.unknown()) }).parse(imported.body);
    const bot = parsed.bots[0]!;
    expect(bot).toMatchObject({ name: "Fixture Eggbot", soul: "Review eggs. Ask before acting." });
    expect(parsed.routines).toEqual([expect.objectContaining({ enabled: false, nextRunAt: null })]);
    expect((await call(`/api/bots/${bot.id}/skills`)).body).toMatchObject({ skills: [
      expect.objectContaining({ name: "egg-review", enabled: false }),
    ] });
    expect((await call("/api/bots")).body).toMatchObject({ bots: expect.arrayContaining([expect.objectContaining({ id: bot.id, soul: "Review eggs. Ask before acting." })]) });
    const savedBots: unknown = JSON.parse(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8"));
    expect(savedBots).toEqual(expect.arrayContaining([expect.objectContaining({ id: bot.id, soul: "Review eggs. Ask before acting." })]));
    const exported = await call("/api/teams/export", { format: "package", version: 2, team: bot.section, includeMemory: true });
    expect(exported.status).toBe(200);
    expect(JSON.stringify(exported.body)).toContain("Only use example.com for test accounts.");
  } finally {
    await fixture.close();
  }
}, 120_000);
