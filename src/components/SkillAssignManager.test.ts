import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

vi.mock("@/state/store", () => ({ api: vi.fn() }));
vi.mock("./Avatar", () => ({ BotAvatar: ({ bot }: { bot: Bot }) => createElement("span", { "data-avatar": bot.id }) }));
import { SkillAssignGrid } from "./SkillAssignManager";
import { summarizeSources, type SourceSkillWire } from "./SkillSourcesCard";
import type { SkillsLibrarySkillWire } from "../../shared/wire";

type Node = ReactElement<{ children?: ReactNode; onClick?: () => void; [key: string]: unknown }>;
function expand(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    if (typeof node.type === "function") return [node, ...expand((node.type as (props: unknown) => ReactNode)(node.props))];
    return [node, ...expand(node.props.children)];
  });
}

const skill = (name: string, fields: Partial<SkillsLibrarySkillWire> = {}): SkillsLibrarySkillWire => ({
  name, description: `Does ${name}.`, source: "local-import", enabled: true, tags: [], version: null,
  importedAt: "2026-10-09T00:00:00Z", warnings: [], skippedFiles: [], assignedBots: [], ...fields,
});
const bot = (id: string) => ({ id, name: `Bot ${id}`, hidden: false, modelSelection: { instanceId: "claude" } }) as unknown as Bot;
const skills = [
  skill("scrape", { source: "hermes:web/scrape", tags: ["hermes", "web"], assignedBots: [{ id: "alpha", name: "Bot alpha" }] }),
  skill("checkpoint", { source: "shared:checkpoint", tags: ["shared"] }),
  skill("box", { source: "hermes:ops/box", enabled: false, tags: ["hermes", "luna-only"], warnings: ["Needs Hermes or Luna: the Hermes home directory"] }),
];
const bots = [bot("alpha"), bot("beta")];

describe("skill assignment grid", () => {
  const onToggle = vi.fn();
  const grid = (view: "row" | "bot" = "row", query = "") => createElement(SkillAssignGrid, { skills, bots, view, bot: bots[0]!, query, onToggle });

  it("shows every skill against every bot with source and dependency badges", () => {
    const html = renderToStaticMarkup(grid());
    for (const name of ["scrape", "checkpoint", "box"]) expect(html).toContain(`data-grant-row="${name}"`);
    for (const id of ["alpha", "beta"]) expect(html).toContain(`data-grant-bot="${id}"`);
    expect(html).toContain('data-grant-badge="Hermes"');
    expect(html).toContain('data-grant-badge="Shared"');
    expect(html).toContain('data-grant-badge="Needs Hermes or Luna"');
    expect(html).toContain('data-grant-badge="Not approved"');
    expect(html).toContain("Does scrape.");
  });

  it("marks a skill on for the bot that has it, and calls the toggle with skill, bot and state", () => {
    const html = renderToStaticMarkup(grid());
    expect(html).toMatch(/aria-checked="true"[^>]*data-grant-cell="scrape:alpha"|data-grant-cell="scrape:alpha"[^>]*aria-checked="true"/);
    expect(html).not.toMatch(/aria-checked="true"[^>]*data-grant-cell="scrape:beta"/);
    const cells = expand(grid()).filter((node) => typeof node.props["data-grant-cell"] === "string");
    const cell = (id: string) => cells.find((node) => node.props["data-grant-cell"] === id)!;
    cell("checkpoint:beta").props.onClick!();
    expect(onToggle).toHaveBeenLastCalledWith(expect.objectContaining({ name: "checkpoint" }), expect.objectContaining({ id: "beta" }), true);
    cell("scrape:alpha").props.onClick!();
    expect(onToggle).toHaveBeenLastCalledWith(expect.objectContaining({ name: "scrape" }), expect.objectContaining({ id: "alpha" }), false);
  });

  it("will not hand out a skill that is not approved", () => {
    const cells = expand(grid()).filter((node) => typeof node.props["data-grant-cell"] === "string");
    expect(cells.find((node) => node.props["data-grant-cell"] === "box:alpha")!.props.disabled).toBe(true);
    expect(cells.find((node) => node.props["data-grant-cell"] === "checkpoint:alpha")!.props.disabled).toBe(false);
  });

  it("shows one bot's skills split into on and off, and filters by search", () => {
    const html = renderToStaticMarkup(grid("bot"));
    expect(html).toContain('data-grant-bot-view="alpha"');
    expect(html).toContain("Skills on: 1");
    expect(html.indexOf("On for this bot")).toBeLessThan(html.indexOf('data-grant-bot-row="scrape"'));
    expect(html.indexOf('data-grant-bot-row="scrape"')).toBeLessThan(html.indexOf("Off for this bot"));
    expect(html.indexOf("Off for this bot")).toBeLessThan(html.indexOf('data-grant-bot-row="checkpoint"'));
    expect(renderToStaticMarkup(grid("row", "shared"))).not.toContain('data-grant-row="scrape"');
    expect(renderToStaticMarkup(grid("row", "nothing-matches"))).toContain("No skills match.");
  });
});

describe("what a bulk import would do", () => {
  const row = (name: string, fields: Partial<SourceSkillWire> = {}): SourceSkillWire => ({
    name, source: "hermes", category: "", description: "", lunaDependent: [], secretLiterals: [], converted: [], libraryState: null, ...fields,
  });
  it("brings in clean new skills and holds the flagged ones, counting skipped duplicates", () => {
    const summary = summarizeSources([
      row("clean"), row("luna", { lunaDependent: ["the hermes command"] }), row("secret", { secretLiterals: ["an API key (sk-…)"] }),
      row("done", { libraryState: "same" }), row("twin", { source: "shared", duplicateOf: "hermes" }), row("broken", { error: "bad" }),
    ]);
    expect(summary.clean.map((entry) => entry.name)).toEqual(["clean"]);
    expect(summary.held.map((entry) => entry.name)).toEqual(["luna", "secret"]);
    expect(summary.conflicts.map((entry) => entry.name)).toEqual(["twin"]);
    expect(summary.inLibrary("hermes")).toBe(1);
  });
});
