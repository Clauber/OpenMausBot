import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  addMarketplace,
  expandPluginVars,
  forgetBotPluginAccess,
  installPlugin,
  listPlugins,
  marketplaceCatalog,
  pluginMcpServersForBot,
  pluginSkillsForBot,
  readSkillFrontmatter,
  removeMarketplace,
  setPluginAccess,
  uninstallPlugin,
} from "./plugin-marketplace.ts";

let base: string;
let root: string;
let home: string;

function write(path: string, content: unknown) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
}

function skill(dir: string, name: string, description: string) {
  write(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nBody\n`);
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "omb-plugins-test-"));
  root = join(base, "data", "plugins");
  home = join(base, "home");
  process.env.OMB_PLUGIN_HARNESS_HOME = home;
});
afterEach(() => {
  delete process.env.OMB_PLUGIN_HARNESS_HOME;
  rmSync(base, { recursive: true, force: true });
});

describe("harness discovery", () => {
  it("lists Claude Code, ZCode and Codex installs with their skills, servers and unsupported parts", () => {
    const claudeDir = join(home, ".claude/plugins/cache/mkt/alpha/1.0.0");
    write(join(claudeDir, ".claude-plugin/plugin.json"), { name: "alpha", description: "Alpha plugin" });
    skill(join(claudeDir, "skills"), "do-thing", "Does the thing");
    write(join(claudeDir, "hooks/hooks.json"), {});
    write(join(home, ".claude/plugins/installed_plugins.json"), {
      version: 2,
      plugins: { "alpha@mkt": [{ scope: "user", installPath: claudeDir, version: "1.0.0" }] },
    });

    const zcodeDir = join(home, ".zcode/cli/plugins/cache/official/ctx/0.0.0");
    write(join(zcodeDir, ".claude-plugin/plugin.json"), { name: "ctx" });
    write(join(zcodeDir, ".mcp.json"), { mcpServers: { ctx: { type: "http", url: "https://example.com/mcp" } } });
    write(join(home, ".zcode/cli/plugins/installed_plugins.json"), {
      version: 1,
      plugins: [{ id: "ctx@official", name: "ctx", marketplace: "official", version: "0.0.0", installPath: zcodeDir }],
    });

    const codexDir = join(home, ".codex/plugins/cache/openai/viz/0.2.0");
    write(join(codexDir, ".codex-plugin/plugin.json"), { name: "viz", apps: "./.app.json" });

    const plugins = listPlugins(root);
    expect(plugins.map((plugin) => plugin.key).sort()).toEqual(["claude:alpha@mkt", "codex:viz@openai", "zcode:ctx@official"]);
    const alpha = plugins.find((plugin) => plugin.key === "claude:alpha@mkt")!;
    expect(alpha).toMatchObject({ skills: [{ name: "do-thing", description: "Does the thing" }], unsupported: ["hooks"], access: "off", usable: true });
    expect(plugins.find((plugin) => plugin.origin === "zcode")).toMatchObject({ mcpServers: ["ctx"], usable: true });
    expect(plugins.find((plugin) => plugin.origin === "codex")).toMatchObject({ unsupported: ["apps"], usable: false });
  });
});

describe("access and delivery", () => {
  beforeEach(() => {
    const dir = join(home, ".zcode/cli/plugins/cache/official/ctx/0.0.0");
    write(join(dir, ".zcode-plugin/plugin.json"), { name: "ctx", skills: "skills" });
    skill(join(dir, "skills"), "lookup", "Look things up");
    write(join(dir, ".mcp.json"), {
      mcpServers: {
        ctx: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "${OMB_TEST_UNSET_KEY:-}" } },
        local: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.js"] },
      },
    });
    write(join(home, ".zcode/cli/plugins/installed_plugins.json"), {
      version: 1,
      plugins: [{ id: "ctx@official", name: "ctx", marketplace: "official", version: "0.0.0", installPath: dir }],
    });
  });

  it("reaches nobody until granted, then exactly the granted bots", () => {
    expect(pluginSkillsForBot("bot-a", root)).toEqual([]);
    expect(setPluginAccess("zcode:ctx@official", ["bot-a"], root)).toMatchObject({ access: ["bot-a"] });
    expect(pluginSkillsForBot("bot-a", root).map((entry) => entry.name)).toEqual(["ctx:lookup"]);
    expect(pluginSkillsForBot("bot-b", root)).toEqual([]);
    setPluginAccess("zcode:ctx@official", "all", root);
    expect(pluginSkillsForBot("bot-b", root)).toHaveLength(1);
    setPluginAccess("zcode:ctx@official", "off", root);
    expect(pluginSkillsForBot("bot-b", root)).toEqual([]);
  });

  it("expands plugin variables, drops empty headers and renames around the person's own servers", () => {
    setPluginAccess("zcode:ctx@official", "all", root);
    const dir = join(home, ".zcode/cli/plugins/cache/official/ctx/0.0.0");
    const servers = pluginMcpServersForBot("bot-a", ["ctx"], root);
    expect(servers).toEqual({
      "ctx-ctx": { type: "http", url: "https://example.com/mcp", headers: {} },
      local: { command: "node", args: [`${dir}/server.js`] },
    });
  });

  it("forgets a deleted bot", () => {
    setPluginAccess("zcode:ctx@official", ["bot-a"], root);
    forgetBotPluginAccess("bot-a", root);
    expect(listPlugins(root)[0]!.access).toBe("off");
  });
});

describe("marketplaces", () => {
  it("adds a local marketplace, installs a path plugin, and uninstalls it", async () => {
    const market = join(base, "market");
    write(join(market, ".claude-plugin/marketplace.json"), {
      name: "Team Market",
      plugins: [
        { name: "helper", description: "Helps", source: "./plugins/helper" },
        { name: "escape", source: "../../etc" },
        { name: "npm-thing", source: { source: "npm", package: "x" } },
      ],
    });
    write(join(market, "plugins/helper/.claude-plugin/plugin.json"), { name: "helper", version: "1.2.0" });
    skill(join(market, "plugins/helper/skills"), "help-me", "Help");

    const added = await addMarketplace(market, root);
    expect(added).toMatchObject({ id: "team-market", name: "Team Market" });
    const catalog = marketplaceCatalog("team-market", root);
    expect(catalog).toEqual([
      { name: "helper", description: "Helps", installable: true, installed: false },
      { name: "escape", installable: true, installed: false },
      { name: "npm-thing", installable: false, installed: false },
    ]);

    expect(await installPlugin("team-market", "escape", root)).toMatchObject({ error: expect.stringContaining("leaves its marketplace") });
    const installed = await installPlugin("team-market", "helper", root);
    expect(installed).toMatchObject({ key: "omb:helper@team-market", version: "1.2.0", skills: [{ name: "help-me" }] });
    expect(removeMarketplace("team-market", root)).toMatchObject({ error: expect.any(String) });

    setPluginAccess("omb:helper@team-market", ["bot-a"], root);
    expect(pluginSkillsForBot("bot-a", root)[0]!.file).toContain(join("plugins", "cache", "team-market", "helper", "1.2.0"));
    expect(uninstallPlugin("omb:helper@team-market", root)).toEqual({ removed: true });
    expect(pluginSkillsForBot("bot-a", root)).toEqual([]);
    expect(removeMarketplace("team-market", root)).toEqual({ removed: true });
  });

  it("rejects input it cannot read as a marketplace", async () => {
    expect(await addMarketplace("not a source", root)).toMatchObject({ error: expect.any(String) });
    expect(await addMarketplace(join(base, "missing"), root)).toMatchObject({ error: expect.any(String) });
  });
});

describe("helpers", () => {
  it("reads folded frontmatter descriptions", () => {
    expect(readSkillFrontmatter("---\nname: x\ndescription: >\n  one\n  two\n---\n")).toEqual({ name: "x", description: "one two" });
  });
  it("expands defaults and plugin roots", () => {
    expect(expandPluginVars("${PLUGIN_ROOT}/a ${NOPE:-d} ${HAS}", "/p", { HAS: "v" })).toBe("/p/a d v");
  });
});
