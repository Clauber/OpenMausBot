import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { threadBrowserProfileSchema } from "../shared/thread-browser-profile.ts";
import { launchRestartableServer, type RestartableServer } from "./testing/restartable-server.ts";

let fixture: RestartableServer;
let botId: string;
let threadId: string;

function mountedToken(): string {
  const dump = JSON.parse(readFileSync(join(fixture.dataDir, "profile-fixture-dump.json"), "utf8"));
  let server = dump.mcpConfig.mcpServers.browser;
  while (server.env.OMB_GATE_UPSTREAM) server = JSON.parse(server.env.OMB_GATE_UPSTREAM);
  return server.env.OMB_MCP_TOKEN_BROWSER;
}

const botReply = z.object({ id: z.string(), threadId: z.string(), browserProfile: z.string().optional(), busy: z.boolean().optional() });
const replySchema = z.object({
  bot: botReply.optional(), bots: z.array(botReply).optional(), error: z.string().optional(),
  result: z.object({
    isError: z.boolean().optional(), structuredContent: threadBrowserProfileSchema.optional(),
    tools: z.array(z.object({ name: z.string() })).optional(),
  }).optional(),
}).catchall(z.unknown());

async function api(method: string, path: string, body?: unknown, token?: string) {
  const response = await fetch(`${fixture.url}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  const answer = replySchema.parse(await response.json());
  return {
    status: response.status, body: answer,
    get bot() { if (!answer.bot) throw new Error("Expected a bot reply."); return answer.bot; },
    get bots() { if (!answer.bots) throw new Error("Expected a bots reply."); return answer.bots; },
    get result() {
      const result = answer.result;
      if (!result) throw new Error("Expected an MCP result.");
      return { isError: result.isError, tools: result.tools ?? [],
        get structuredContent() { if (!result.structuredContent) throw new Error("Expected browser profile state."); return result.structuredContent; },
      };
    },
  };
}

beforeAll(async () => {
  vi.stubEnv("FAKE_CLAUDE_MODE", "slow");
  vi.stubEnv("FAKE_CLAUDE_SLOW_FINISH_GATE", "/nonexistent-mounted-profile-fixture-gate");
  fixture = await launchRestartableServer();
  expect((await api("PATCH", "/api/config", {
    features: { browser: true }, browserEngine: { engine: "chrome" },
    browserProfiles: [{ id: "work", name: "Work" }, { id: "other", name: "Other" }],
  })).status).toBe(200);
  const config = JSON.parse(readFileSync(join(fixture.dataDir, "config.json"), "utf8"));
  await fixture.stop();
  config.instances["profile-fixture"] = { ...config.instances.claude, displayName: "Profile fixture", environment: { FAKE_CLAUDE_DUMP: join(fixture.dataDir, "profile-fixture-dump.json") } };
  writeFileSync(join(fixture.dataDir, "config.json"), JSON.stringify(config));
  await fixture.start();
  const created = await api("POST", "/api/bots", { name: "Mounted profile fixture", browser: true, computer: "browser", modelSelection: { instanceId: "profile-fixture", model: "claude-sonnet-5" } });
  expect(created.status).toBe(201);
  botId = created.bot.id;
  threadId = created.bot.threadId;
}, 30_000);

afterAll(async () => { await fixture?.close(); vi.unstubAllEnvs(); });

describe("thread browser profile selection", () => {
  it("keeps deleted and unavailable requested profiles explicit at next-turn activation", async () => {
    const original = [{ id: "work", name: "Work" }, { id: "other", name: "Other" }];
    const extras = [{ id: "retired", name: "Retired fixture" }, { id: "remote", name: "Remote fixture" }];
    expect((await api("PATCH", "/api/config", { browserProfiles: [...original, ...extras] })).status).toBe(200);
    const created = await api("POST", "/api/bots", { name: "Unavailable activation fixture", browser: true, computer: "browser" });
    const id = created.bot.id;
    const thread = created.bot.threadId;
    const path = `/api/bots/${id}/browser-profile?threadId=${thread}`;
    expect((await api("PUT", path, { profileId: "retired" })).status).toBe(200);
    expect((await api("PATCH", "/api/config", { browserProfiles: [...original, extras[1]] })).status).toBe(200);
    expect((await api("POST", `/api/bots/${id}/messages`, { text: "Try the removed browser request.", threadId: thread })).status).toBe(202);
    await expect.poll(async () => (await api("GET", "/api/bots")).bots.find((bot: { id: string }) => bot.id === id)?.busy, { timeout: 15_000 }).toBe(false);
    await expect.poll(async () => (await api("GET", path)).body.status, { timeout: 15_000 }).toBe("error");
    expect((await api("GET", path)).body).toMatchObject({ requestedProfileId: "retired", active: null, viewerProfileId: null, error: expect.stringContaining("deleted") });
    await api("POST", `/api/bots/${id}/interrupt`);
    await expect.poll(async () => (await api("GET", "/api/bots")).bots.find((bot: { id: string }) => bot.id === id)?.busy, { timeout: 10_000 }).toBe(false);
    expect((await api("PUT", path, { profileId: "remote" })).status).toBe(200);
    expect((await api("PATCH", "/api/config", { browserProfiles: [...original, { ...extras[1], browser: "chrome" }] })).status).toBe(200);
    expect((await api("POST", `/api/bots/${id}/messages`, { text: "Try the unavailable browser request.", threadId: thread })).status).toBe(202);
    await expect.poll(async () => (await api("GET", "/api/bots")).bots.find((bot: { id: string }) => bot.id === id)?.busy, { timeout: 15_000 }).toBe(false);
    await expect.poll(async () => (await api("GET", path)).body.status, { timeout: 15_000 }).toBe("error");
    expect((await api("GET", path)).body).toMatchObject({ requestedProfileId: "remote", active: null, viewerProfileId: null, error: expect.stringContaining("unavailable") });
    expect((await api("PUT", path, { profileId: "remote" })).status).toBe(409);
    expect((await api("GET", path)).body.requestedProfileId).toBe("remote");
    await api("POST", `/api/bots/${id}/interrupt`);
    await expect.poll(async () => (await api("GET", "/api/bots")).bots.find((bot: { id: string }) => bot.id === id)?.busy, { timeout: 10_000 }).toBe(false);
    expect((await api("PATCH", "/api/config", { browserProfiles: original })).status).toBe(200);
  }, 45_000);

  it("persists only the requested thread profile without requiring a running browser", async () => {
    const path = `/api/bots/${botId}/browser-profile?threadId=${threadId}`;
    const selected = await api("PUT", path, { profileId: "work" });
    expect(selected.status).toBe(200);
    expect(selected.body).toMatchObject({ requestedProfileId: "work", activeProfileId: null, status: "reconnect" });
    expect((await api("GET", path)).body).toMatchObject({ requestedProfileId: "work", status: "reconnect" });
    const bots = await api("GET", "/api/bots");
    expect(bots.bots.find((bot: { id: string }) => bot.id === botId)?.browserProfile).toBeUndefined();
    expect((await api("PUT", path, { profileId: "missing" })).status).toBe(400);
    expect((await api("GET", path)).body.requestedProfileId).toBe("work");
    expect((await api("GET", `/api/bots/${botId}/browser-profile?threadId=unrelated`)).status).toBe(404);
  });

  it("reports a missing built-in engine without silently dropping the requested mount", async () => {
    const created = await api("POST", "/api/bots", { name: "Missing engine fixture", browser: true, computer: "browser",
      modelSelection: { instanceId: "profile-fixture", model: "claude-sonnet-5" } });
    const id = created.bot.id;
    const thread = created.bot.threadId;
    const path = `/api/bots/${id}/browser-profile?threadId=${thread}`;
    expect((await api("PUT", path, { profileId: "work" })).status).toBe(200);
    await fixture.stop();
    const configPath = join(fixture.dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    writeFileSync(configPath, JSON.stringify({ ...config, browserEngine: { engine: "agent-browser" } }));
    await fixture.start();
    try {
      expect((await api("GET", path)).body).toMatchObject({ status: "error", requestedProfileId: "work", active: null,
        error: expect.stringContaining("agent-browser") });
      expect((await api("PUT", path, { profileId: "other" })).status).toBe(409);
      expect((await api("POST", `/api/bots/${id}/messages`, { text: "Try the missing engine.", threadId: thread })).status).toBe(202);
      await expect.poll(async () => (await api("GET", "/api/bots")).bots.find(bot => bot.id === id)?.busy, { timeout: 15_000 }).toBe(false);
      expect((await api("GET", path)).body).toMatchObject({ status: "error", requestedProfileId: "work", active: null, viewerProfileId: null });
    } finally {
      await fixture.stop();
      writeFileSync(configPath, JSON.stringify(config));
      await fixture.start();
    }
  }, 30_000);

  it("preserves a mounted-tool request and last verified viewer choice across a server restart", async () => {
    expect((await api("PUT", `/api/bots/${botId}/browser-profile?threadId=${threadId}`, { profileId: "work" })).status).toBe(200);
    expect((await api("POST", `/api/bots/${botId}/messages`, { text: "Mount before the persistence restart.", threadId })).status).toBe(202);
    await expect.poll(() => existsSync(join(fixture.dataDir, "profile-fixture-dump.json")) && JSON.stringify(JSON.parse(readFileSync(join(fixture.dataDir, "profile-fixture-dump.json"), "utf8")).prompt).includes("Mount before the persistence restart."), { timeout: 15_000 }).toBe(true);
    const token = mountedToken();
    const selected = await api("POST", "/api/internal/browser/mcp", { method: "tools/call", params: { name: "browser_profile_select", arguments: { profileId: "other" } } }, token);
    expect(selected.result.structuredContent).toMatchObject({ requestedProfileId: "other", viewerProfileId: "work", status: "pending" });
    await fixture.stop();
    await fixture.start();
    const state = await api("GET", `/api/bots/${botId}/browser-profile?threadId=${threadId}`);
    expect(state.body).toMatchObject({ active: null, requestedProfileId: "other", viewerProfileId: "work", status: "reconnect" });
    expect((await api("POST", "/api/internal/browser/mcp", { method: "tools/call", params: { name: "browser_profiles_list", arguments: {} } }, token)).status).toBe(401);
    expect((await api("POST", `/api/bots/${botId}/messages`, { text: "Mount the persisted request after restart.", threadId })).status).toBe(202);
    await expect.poll(() => mountedToken() !== token, { timeout: 15_000 }).toBe(true);
    const active = await api("POST", "/api/internal/browser/mcp", { method: "tools/call", params: { name: "browser_profiles_list", arguments: {} } }, mountedToken());
    expect((await api("GET", `/api/bots/${botId}/browser-profile?threadId=${threadId}`)).body).toMatchObject({ active: { profileId: "other" }, requestedProfileId: "other", viewerProfileId: "other", status: "ready" });
    expect(active.result.structuredContent).toMatchObject({ active: { profileId: "other" }, requestedProfileId: "other", viewerProfileId: "other", status: "ready" });
    expect((await api("POST", `/api/bots/${botId}/interrupt`)).status).toBe(200);
    await expect.poll(async () => (await api("GET", "/api/bots")).bots.find((bot: { id: string }) => bot.id === botId)?.busy, { timeout: 10_000 }).toBe(false);
  }, 60_000);

  it("lists and requests profiles through the mounted capability without starting the browser", async () => {
    expect((await api("PUT", `/api/bots/${botId}/browser-profile?threadId=${threadId}`, { profileId: "work" })).status).toBe(200);
    expect((await api("POST", `/api/bots/${botId}/messages`, { text: "Keep this fixture turn open.", threadId })).status).toBe(202);
    await expect.poll(() => existsSync(join(fixture.dataDir, "profile-fixture-dump.json")) && JSON.stringify(JSON.parse(readFileSync(join(fixture.dataDir, "profile-fixture-dump.json"), "utf8")).prompt).includes("Keep this fixture turn open."), { timeout: 15_000 }).toBe(true);
    const dump = JSON.parse(readFileSync(join(fixture.dataDir, "profile-fixture-dump.json"), "utf8"));
    const token = dump.mcpConfig.mcpServers.browser.env.OMB_MCP_TOKEN_BROWSER;
    expect(typeof token).toBe("string");
    const rpc = (name: string, args = {}) => api("POST", "/api/internal/browser/mcp", { method: "tools/call", params: { name, arguments: args } }, token);
    const listed = await rpc("browser_profiles_list");
    expect(listed.status).toBe(200);
    expect(listed.result.isError).not.toBe(true);
    expect(listed.result.structuredContent).toMatchObject({ activeProfileId: "work", requestedProfileId: "work", status: "ready" });
    const restart = await api("POST", `/api/bots/${botId}/browser/action?threadId=${threadId}`, { viewerId: "fixture-unopened-view", type: "restart" });
    expect(restart.status).toBe(409);
    expect(restart.body.error).toContain("Stop every bot");
    const deletion = await api("PATCH", "/api/config", { browserProfiles: [{ id: "other", name: "Other" }] });
    expect(deletion.status).toBe(409);
    const engineChange = await api("PATCH", "/api/config", { browserProfiles: [{ id: "work", name: "Work", browser: "chrome" }, { id: "other", name: "Other" }] });
    expect(engineChange.status).toBe(409);
    const tools = await api("POST", "/api/internal/browser/mcp", { method: "tools/list" }, token);
    const names = tools.result.tools.map((tool: { name: string }) => tool.name);
    expect(names.filter((name: string) => name === "browser_profiles_list")).toHaveLength(1);
    expect(names.filter((name: string) => name === "browser_profile_select")).toHaveLength(1);
    expect((await rpc("browser_profile_select", { profileId: "work" })).result.structuredContent).toMatchObject({ status: "ready", activeProfileId: "work", requestedProfileId: "work" });
    const selected = await rpc("browser_profile_select", { profileId: "other" });
    expect(selected.status).toBe(200);
    expect(selected.result.structuredContent).toMatchObject({ activeProfileId: "work", requestedProfileId: "other", status: "pending" });
    expect((await rpc("browser_profiles_list")).result.structuredContent).toMatchObject({ activeProfileId: "work", requestedProfileId: "other", status: "pending" });
    const invalid = await rpc("browser_profile_select", { profileId: "missing" });
    expect(invalid.result.isError).toBe(true);
    expect((await rpc("browser_profiles_list")).result.structuredContent.requestedProfileId).toBe("other");
    expect((await api("POST", `/api/bots/${botId}/interrupt`)).status).toBe(200);
    expect((await api("POST", "/api/internal/browser/mcp", { method: "tools/call", params: { name: "browser_profiles_list", arguments: {} } }, token)).status).toBe(401);
    expect((await api("GET", `/api/bots/${botId}/browser-profile?threadId=${threadId}`)).body).toMatchObject({ active: null, requestedProfileId: "other", status: "reconnect" });
    expect((await api("POST", `/api/bots/${botId}/messages`, { text: "Mount the requested browser.", threadId })).status).toBe(202);
    await expect.poll(() => {
      const next = JSON.parse(readFileSync(join(fixture.dataDir, "profile-fixture-dump.json"), "utf8"));
      return next.mcpConfig.mcpServers.browser.env.OMB_MCP_TOKEN_BROWSER;
    }, { timeout: 15_000 }).not.toBe(token);
    const nextToken = JSON.parse(readFileSync(join(fixture.dataDir, "profile-fixture-dump.json"), "utf8")).mcpConfig.mcpServers.browser.env.OMB_MCP_TOKEN_BROWSER;
    const next = await api("POST", "/api/internal/browser/mcp", { method: "tools/call", params: { name: "browser_profiles_list", arguments: {} } }, nextToken);
    expect(next.result.structuredContent).toMatchObject({ active: { profileId: "other" }, activeProfileId: "other", requestedProfileId: "other", status: "ready" });
    let previousToken = nextToken;
    for (const profileId of [null, "guest"]) {
      const changed = await api("POST", "/api/internal/browser/mcp", { method: "tools/call", params: { name: "browser_profile_select", arguments: { profileId } } }, previousToken);
      expect(changed.result.structuredContent).toMatchObject({ requestedProfileId: profileId, status: "pending" });
      expect((await api("POST", `/api/bots/${botId}/interrupt`)).status).toBe(200);
      expect((await api("POST", `/api/bots/${botId}/messages`, { text: "Activate the explicit browser choice.", threadId })).status).toBe(202);
      await expect.poll(() => mountedToken() !== previousToken, { timeout: 15_000 }).toBe(true);
      previousToken = mountedToken();
      const activated = await api("POST", "/api/internal/browser/mcp", { method: "tools/call", params: { name: "browser_profiles_list", arguments: {} } }, previousToken);
      expect(activated.result.structuredContent).toMatchObject({ active: { profileId }, activeProfileId: profileId, requestedProfileId: profileId, status: "ready" });
    }
    expect((await api("POST", `/api/bots/${botId}/interrupt`)).status).toBe(200);
    await expect.poll(async () => (await api("GET", "/api/bots")).bots.find((bot: { id: string }) => bot.id === botId)?.busy, { timeout: 10_000 }).toBe(false);
    expect((await api("PUT", `/api/bots/${botId}/browser-profile?threadId=${threadId}`, { profileId: "other" })).status).toBe(200);
    expect((await api("PATCH", `/api/bots/${botId}`, { toolScope: { deny: ["mcp:browser:browser_profile_select"] } })).status).toBe(200);
    expect((await api("POST", `/api/bots/${botId}/messages`, { text: "Keep a scoped fixture turn open.", threadId })).status).toBe(202);
    await expect.poll(() => JSON.parse(readFileSync(join(fixture.dataDir, "profile-fixture-dump.json"), "utf8")).mcpConfig.mcpServers.browser.env.OMB_MCP_TOKEN_BROWSER, { timeout: 15_000 }).not.toBe(previousToken);
    const scopedToken = mountedToken();
    expect(typeof scopedToken).toBe("string");
    const denied = await api("POST", "/api/internal/browser/mcp", { method: "tools/call", params: { name: "browser_profile_select", arguments: { profileId: "work" } } }, scopedToken);
    expect(denied.status).toBe(403);
    expect((await api("GET", `/api/bots/${botId}/browser-profile?threadId=${threadId}`)).body.requestedProfileId).toBe("other");
    expect((await api("POST", `/api/bots/${botId}/interrupt`)).status).toBe(200);
    await expect.poll(async () => (await api("GET", "/api/bots")).bots.find((bot: { id: string }) => bot.id === botId)?.busy, { timeout: 10_000 }).toBe(false);
  }, 60_000);
});
