import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

const FAKE_SK = `sk-${"A1b2".repeat(8)}`;
const skill = (name: string, description: string, body = `# ${name}\n`) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;

it("imports mirrored skills, holds flagged ones, and assigns approved ones to one bot's next turn", async () => {
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: "happy" });
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = { status: response.status, body: await response.json() as any };
    evidence.push({ method, path, status: result.status, body: result.body });
    return result;
  };
  const control = async (args: string[]): Promise<any> => runControlOmb([...args, "--url", fixture.info.url]);
  const turnPrompt = async (botId: string) => {
    rmSync(fixture.fixtureDumpPath, { force: true });
    await control(["send", "--bot", botId, "--text", "Reply briefly."]);
    await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 15_000 }).toBe(true);
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as { systemPrompt: string | null };
    expect((await control(["wait", "--bot", botId, "--timeout", "30"])).status).toBe("settled");
    return dump.systemPrompt ?? "";
  };
  try {
    // Off by default: nothing is reachable until the flag is on.
    expect((await api("GET", "/api/skill-sources")).status).toBe(404);
    expect((await api("PATCH", "/api/config", { features: { skillsLibrary: true } })).status).toBe(200);

    const mirror = (rel: string, text: string) => {
      const file = join(fixture.info.dataDir, "skill-sources", rel);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    };
    mirror("hermes/web/DESCRIPTION.md", "Web skills.\n");
    mirror("hermes/web/scrape/SKILL.md", skill("scrape", "Scrape a page."));
    mirror("hermes/web/scrape/references/api.md", "ref\n");
    mirror("hermes/ops/box/SKILL.md", skill("box", "Operate the box.", "Edit /home/shado/box.yaml\n"));
    mirror("hermes/leaky/SKILL.md", skill("leaky", "Has a key.", `Use ${FAKE_SK}\n`));
    mirror("shared/checkpoint/SKILL.md", "---\nname: checkpoint\ndescription: |\n  Save\n  state.\n---\nbody\n");

    const listed = await api("GET", "/api/skill-sources");
    expect(listed.status).toBe(200);
    expect(listed.body.sources).toEqual([
      { id: "shared", label: "Shared harness skills", count: 1, present: true },
      { id: "hermes", label: "Hermes skills", count: 3, present: true },
    ]);
    const row = (name: string) => listed.body.skills.find((entry: { name: string }) => entry.name === name);
    expect(row("scrape")).toMatchObject({ source: "hermes", category: "web", categoryDescription: "Web skills.", supportingFiles: ["references/api.md"], libraryState: null });
    expect(row("box").lunaDependent).toEqual(["a path under /home/shado (Luna)"]);
    expect(row("leaky").secretLiterals).toEqual(["an API key (sk-…)"]);
    expect(row("checkpoint").converted).toEqual(["description folded onto one line"]);
    expect(JSON.stringify(listed.body)).not.toContain(FAKE_SK);

    const imported = await api("POST", "/api/skill-sources/import", { all: true });
    expect(imported.body).toMatchObject({
      imported: expect.arrayContaining(["scrape", "checkpoint"]),
      held: expect.arrayContaining([{ name: "box", source: "hermes", reason: "lunaDependent" }, { name: "leaky", source: "hermes", reason: "secretLiteral" }]),
    });
    expect((await api("POST", "/api/skill-sources/import", {})).status).toBe(400);
    expect((await api("GET", "/api/skill-sources")).body.skills.find((entry: { name: string }) => entry.name === "scrape").libraryState).toBe("same");

    const library = (await api("GET", "/api/skills-library")).body.skills as Array<{ name: string; enabled: boolean; source: string; skippedFiles: string[]; tags: string[] }>;
    expect(library.map((entry) => entry.name).sort()).toEqual(["checkpoint", "scrape"]);
    expect(library.find((entry) => entry.name === "scrape")).toMatchObject({ enabled: false, source: "hermes:web/scrape", skippedFiles: ["references/api.md"] });
    expect(JSON.stringify(library)).not.toContain(FAKE_SK);

    // Assignment alone changes nothing while the skill is unreviewed...
    const { bot: tester } = await control(["new-bot", "--name", "Skill tester"]) as { bot: { id: string } };
    const { bot: other } = await control(["new-bot", "--name", "Other bot"]) as { bot: { id: string } };
    expect((await api("PUT", `/api/bots/${tester.id}/skills-library`, { skills: ["scrape"] })).body).toEqual({ assignedSkills: ["scrape"] });
    expect(await turnPrompt(tester.id)).not.toContain("- scrape:");
    // ...approval plus assignment reaches the next turn, for that bot only...
    expect((await api("PATCH", "/api/skills-library/scrape", { enabled: true })).status).toBe(200);
    const withSkill = await turnPrompt(tester.id);
    expect(withSkill).toContain("- scrape: Scrape a page.");
    expect(await turnPrompt(other.id)).not.toContain("- scrape:");
    // ...and removing it takes it away again.
    expect((await api("PUT", `/api/bots/${tester.id}/skills-library`, { skills: [] })).status).toBe(200);
    expect(await turnPrompt(tester.id)).not.toContain("- scrape:");
    // a name nobody imported cannot be assigned
    expect((await api("PUT", `/api/bots/${tester.id}/skills-library`, { skills: ["box"] })).status).toBe(422);
  } finally {
    await fixture.close();
    const evidencePath = `${fixture.info.logPath}.skill-sources.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    expect(existsSync(fixture.info.dataDir)).toBe(false);
  }
}, 120_000);
