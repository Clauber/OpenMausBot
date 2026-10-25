import { describe, expect, it, vi } from "vitest";

import {
  accessBots,
  accessLockReason,
  botAppCount,
  botHasApp,
  buildAccessApps,
  matchesAccessSearch,
  nextBotGrant,
  setAppAccess,
  type AccessDeps,
  type CatalogApp,
} from "./mcp-access";
import type { Bot, InstanceInfo } from "@/state/store";

const catalog: CatalogApp[] = [
  { name: "gog", label: "Gmail & Calendar", description: "Mail and calendar.", transport: "http", target: "http://gateway.example.test/mcp", installed: false, enabled: false, secrets: [{ name: "x-litellm-api-key", envKey: "GOG_GATEWAY_KEY", available: true }] },
  { name: "vault", label: "Vault", description: "Secrets store.", transport: "http", target: "http://gateway.example.test/mcp", installed: false, enabled: false, secrets: [{ name: "x-api-key", available: false }] },
  { name: "notes", label: "Notes", description: "Saved notes.", transport: "stdio", target: "notes-mcp", installed: true, enabled: true, secrets: [] },
];
const servers = [{ name: "notes", enabled: true }, { name: "scratch", enabled: false }, { name: "extra", enabled: true }];
const bot = (id: string, fields: Partial<Bot> = {}) => ({ id, name: id, modelSelection: { instanceId: "claude" }, ...fields }) as unknown as Bot;
const engine = (customMcp: boolean) => [{ instanceId: "claude", capabilities: { customMcp } }] as unknown as InstanceInfo[];

describe("the access manager's app list", () => {
  const apps = buildAccessApps(servers, catalog);

  it("lists installed servers first, then catalog apps that are not installed", () => {
    expect(apps.map((app) => [app.name, app.installed, app.enabled])).toEqual([
      ["notes", true, true], ["scratch", true, false], ["extra", true, true], ["gog", false, false], ["vault", false, false],
    ]);
  });

  it("names catalog apps and says which secret an install is still missing", () => {
    expect(apps.find((app) => app.name === "notes")).toMatchObject({ label: "Notes", description: "Saved notes." });
    expect(apps.find((app) => app.name === "extra")).toMatchObject({ label: "extra", missingSecrets: [] });
    expect(apps.find((app) => app.name === "gog")?.missingSecrets).toEqual([]);
    expect(apps.find((app) => app.name === "vault")?.missingSecrets).toEqual(["x-api-key"]);
  });

  it("searches label, name and description", () => {
    const gog = apps.find((app) => app.name === "gog")!;
    expect(matchesAccessSearch(gog, "calendar")).toBe(true);
    expect(matchesAccessSearch(gog, "GOG")).toBe(true);
    expect(matchesAccessSearch(gog, "slack")).toBe(false);
    expect(matchesAccessSearch(gog, "  ")).toBe(true);
  });
});

describe("who has which app", () => {
  it("follows the turn's rule: an own list, else every enabled server", () => {
    expect(botHasApp(bot("a"), servers, "notes")).toBe(true);
    expect(botHasApp(bot("a"), servers, "scratch")).toBe(false);
    expect(botHasApp(bot("a", { mcpServers: ["notes"] }), servers, "extra")).toBe(false);
    expect(botHasApp(bot("a", { mcpServers: ["scratch"] }), servers, "scratch")).toBe(false);
    expect(botAppCount(bot("a"), servers)).toBe(2);
    expect(botAppCount(bot("a", { mcpServers: [] }), servers)).toBe(0);
  });

  it("pins a bot on 'every enabled server' to what it has today, plus or minus the app", () => {
    expect(nextBotGrant(bot("a"), ["notes", "extra"], "gog", true)).toEqual(["notes", "extra", "gog"]);
    expect(nextBotGrant(bot("a"), ["notes", "extra"], "notes", false)).toEqual(["extra"]);
    expect(nextBotGrant(bot("a", { mcpServers: ["notes"] }), ["notes", "extra"], "gog", true)).toEqual(["notes", "gog"]);
    expect(nextBotGrant(bot("a", { mcpServers: ["notes", "gog"] }), [], "gog", true)).toEqual(["notes", "gog"]);
    expect(nextBotGrant(bot("a", { mcpServers: ["gog"] }), [], "gog", false)).toEqual([]);
  });

  it("lists visible bots and locks a working bot or an engine without MCP", () => {
    expect(accessBots([bot("a"), bot("b", { hidden: true })]).map((row) => row.id)).toEqual(["a"]);
    expect(accessLockReason(bot("a"), engine(true))).toBeNull();
    expect(accessLockReason(bot("a", { busy: true }), engine(true))).toBe("busy");
    expect(accessLockReason(bot("a"), engine(false))).toBe("engine");
    expect(accessLockReason(bot("a"), [])).toBeNull();
  });
});

describe("a toggle", () => {
  const apps = buildAccessApps(servers, catalog);
  const gog = apps.find((app) => app.name === "gog")!;
  const notes = apps.find((app) => app.name === "notes")!;
  const deps = (reply: { servers?: { name: string; enabled: boolean }[] } | Error = { servers: [{ name: "gog", enabled: true }] }) => {
    const calls: string[] = [];
    const api = vi.fn(async (path: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (reply instanceof Error) throw reply;
      return reply;
    });
    const value: AccessDeps = {
      api,
      saveGrant: vi.fn(() => { calls.push("save"); }),
      publishServers: vi.fn(),
      reloadCatalog: vi.fn(async () => { calls.push("catalog"); }),
    };
    return { value, calls, api };
  };

  it("on, for an app that is not installed, installs it first and then grants this bot only", async () => {
    const { value, calls } = deps();
    await setAppAccess(value, { app: gog, bot: bot("tester"), on: true, servers });
    expect(calls).toEqual(["POST /api/mcp/apps/gog/enable", "catalog", "save"]);
    expect(value.publishServers).toHaveBeenCalledWith([{ name: "gog", enabled: true }]);
    expect(value.saveGrant).toHaveBeenCalledWith("tester", ["notes", "extra", "gog"]);
  });

  it("forwards a one-time secret in the request body and nowhere else", async () => {
    const { value, api } = deps();
    await setAppAccess(value, { app: gog, bot: bot("tester"), on: true, servers, secrets: { "x-litellm-api-key": "typed-once" } });
    expect(api).toHaveBeenCalledWith("/api/mcp/apps/gog/enable", { method: "POST", body: JSON.stringify({ secrets: { "x-litellm-api-key": "typed-once" } }) });
    expect(JSON.stringify(vi.mocked(value.saveGrant).mock.calls)).not.toContain("typed-once");
  });

  it("on, for an installed enabled app, only edits the bot's list", async () => {
    const { value, calls } = deps();
    await setAppAccess(value, { app: notes, bot: bot("tester", { mcpServers: [] }), on: true, servers });
    expect(calls).toEqual(["save"]);
    expect(value.saveGrant).toHaveBeenCalledWith("tester", ["notes"]);
  });

  it("off removes the bot's grant and leaves the app installed", async () => {
    const { value, calls } = deps();
    await setAppAccess(value, { app: notes, bot: bot("tester"), on: false, servers });
    expect(calls).toEqual(["save"]);
    expect(value.saveGrant).toHaveBeenCalledWith("tester", ["extra"]);
  });

  it("saves nothing when the install is refused", async () => {
    const { value } = deps(new Error("Needs x-litellm-api-key."));
    await expect(setAppAccess(value, { app: gog, bot: bot("tester"), on: true, servers })).rejects.toThrow("Needs x-litellm-api-key.");
    expect(value.saveGrant).not.toHaveBeenCalled();
  });
});
