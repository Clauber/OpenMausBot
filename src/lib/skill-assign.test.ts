import { describe, expect, it, vi } from "vitest";

import {
  buildSkillRows,
  nextSkillAssignments,
  setSkillAssignment,
  skillBadges,
  skillLock,
  skillOn,
  skillSourceKind,
} from "./skill-assign";
import type { SkillsLibrarySkillWire } from "../../shared/wire";

const skill = (name: string, fields: Partial<SkillsLibrarySkillWire> = {}): SkillsLibrarySkillWire => ({
  name, description: `Does ${name}.`, source: "local-import", enabled: true, tags: [], version: null,
  importedAt: "2026-10-09T00:00:00Z", warnings: [], skippedFiles: [], assignedBots: [], ...fields,
});
const library = [
  skill("scrape", { source: "hermes:web/scrape", tags: ["hermes", "web"], assignedBots: [{ id: "a", name: "A" }] }),
  skill("checkpoint", { source: "shared:checkpoint", tags: ["shared"], assignedBots: [{ id: "a", name: "A" }, { id: "b", name: "B" }] }),
  skill("box", { source: "hermes:ops/box", enabled: false, tags: ["hermes", "luna-only"], warnings: ["Needs Hermes or Luna: a path under /home/shado (Luna)"] }),
  skill("mine"),
];

describe("skill sources and badges", () => {
  it("reads where a skill came from", () => {
    expect(skillSourceKind("hermes:web/scrape")).toBe("hermes");
    expect(skillSourceKind("shared:checkpoint")).toBe("shared");
    expect(skillSourceKind("local-import")).toBe("local");
    expect(skillSourceKind("https://example.test/x")).toBe("other");
  });

  it("badges the source, an unapproved skill and a Hermes or Luna dependency", () => {
    expect(skillBadges(library[0]!).map((badge) => badge.text)).toEqual(["Hermes"]);
    expect(skillBadges(library[1]!).map((badge) => badge.text)).toEqual(["Shared"]);
    expect(skillBadges(library[3]!).map((badge) => badge.text)).toEqual(["Local"]);
    const box = skillBadges(library[2]!);
    expect(box.map((badge) => [badge.text, badge.tone])).toEqual([["Hermes", undefined], ["Not approved", undefined], ["Needs Hermes or Luna", "warn"]]);
    expect(box[2]!.title).toContain("/home/shado");
  });
});

describe("the assignment rows", () => {
  const rows = buildSkillRows(library, "");

  it("lists every skill with its description, in library order, and filters by search", () => {
    expect(rows.map((row) => row.id)).toEqual(["scrape", "checkpoint", "box", "mine"]);
    expect(rows[0]).toMatchObject({ label: "scrape", note: "Does scrape." });
    expect(buildSkillRows(library, "shared").map((row) => row.id)).toEqual(["checkpoint"]);
    expect(buildSkillRows(library, "Does box").map((row) => row.id)).toEqual(["box"]);
  });

  it("reads who has a skill from its assignments", () => {
    expect(skillOn(library[0]!, "a")).toBe(true);
    expect(skillOn(library[0]!, "b")).toBe(false);
    expect(skillOn(library[1]!, "b")).toBe(true);
  });

  it("locks turning on a skill nobody has approved, but never turning one off", () => {
    expect(skillLock(library[2]!, false)).toMatch(/Approve/);
    expect(skillLock(library[2]!, true)).toBeNull();
    expect(skillLock(library[0]!, false)).toBeNull();
  });
});

describe("an assignment change", () => {
  it("adds or removes one skill from one bot's whole list", () => {
    expect(nextSkillAssignments(library, "a", "mine", true)).toEqual(["scrape", "checkpoint", "mine"]);
    expect(nextSkillAssignments(library, "a", "scrape", false)).toEqual(["checkpoint"]);
    expect(nextSkillAssignments(library, "b", "scrape", true)).toEqual(["checkpoint", "scrape"]);
    expect(nextSkillAssignments(library, "a", "scrape", true)).toEqual(["scrape", "checkpoint"]);
  });

  it("saves through the library's own assignment route, for that bot only", async () => {
    const api = vi.fn(async () => ({ assignedSkills: [] as string[] }));
    await setSkillAssignment(api, library, "a", "mine", true);
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith("/api/bots/a/skills-library", { method: "PUT", body: JSON.stringify({ skills: ["scrape", "checkpoint", "mine"] }) });
    await setSkillAssignment(api, library, "b", "checkpoint", false);
    expect(api).toHaveBeenLastCalledWith("/api/bots/b/skills-library", { method: "PUT", body: JSON.stringify({ skills: [] }) });
  });
});
