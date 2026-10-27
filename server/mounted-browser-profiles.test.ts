import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";

let fixture: VerificationServer;
let botId: string;
let threadId: string;

async function api(method: string, path: string, body?: unknown, token?: string) {
  const response = await fetch(`${fixture.info.url}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: "/nonexistent-mounted-profile-fixture-gate" });
  expect((await api("PATCH", "/api/config", {
    features: { browser: true }, browserEngine: { engine: "chrome" },
    browserProfiles: [{ id: "work", name: "Work" }, { id: "other", name: "Other" }],
  })).status).toBe(200);
  const created = await api("POST", "/api/bots", { name: "Mounted profile fixture", browser: true, computer: "browser" });
  expect(created.status).toBe(201);
  botId = created.body.bot.id;
  threadId = created.body.bot.threadId;
}, 30_000);

afterAll(async () => { await fixture?.close(); });

describe("thread browser profile selection", () => {
  it("persists only the requested thread profile without requiring a running browser", async () => {
    const path = `/api/bots/${botId}/browser-profile?threadId=${threadId}`;
    const selected = await api("PUT", path, { profileId: "work" });
    expect(selected.status).toBe(200);
    expect(selected.body).toMatchObject({ requestedProfileId: "work", activeProfileId: null, status: "reconnect" });
    expect((await api("GET", path)).body).toMatchObject({ requestedProfileId: "work", status: "reconnect" });
    const bots = await api("GET", "/api/bots");
    expect(bots.body.bots.find((bot: { id: string }) => bot.id === botId).browserProfile).toBeUndefined();
    expect((await api("PUT", path, { profileId: "missing" })).status).toBe(400);
    expect((await api("GET", path)).body.requestedProfileId).toBe("work");
    expect((await api("GET", `/api/bots/${botId}/browser-profile?threadId=unrelated`)).status).toBe(404);
  });

  it("lists and requests profiles through the mounted capability without starting the browser", async () => {
    expect((await api("POST", `/api/bots/${botId}/messages`, { text: "Keep this fixture turn open." })).status).toBe(202);
    await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 15_000 }).toBe(true);
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    const token = dump.mcpConfig.mcpServers.browser.env.OMB_MCP_TOKEN_BROWSER;
    expect(typeof token).toBe("string");
    const rpc = (name: string, args = {}) => api("POST", "/api/internal/browser/mcp", { method: "tools/call", params: { name, arguments: args } }, token);
    const listed = await rpc("browser_profiles_list");
    expect(listed.status).toBe(200);
    expect(listed.body.result.isError).not.toBe(true);
    expect(listed.body.result.structuredContent).toMatchObject({ activeProfileId: "work", requestedProfileId: "work", status: "ready" });
    const selected = await rpc("browser_profile_select", { profileId: "other" });
    expect(selected.status).toBe(200);
    expect(selected.body.result.structuredContent).toMatchObject({ activeProfileId: "work", requestedProfileId: "other", status: "pending" });
    expect((await rpc("browser_profiles_list")).body.result.structuredContent).toMatchObject({ activeProfileId: "work", requestedProfileId: "other", status: "pending" });
    const invalid = await rpc("browser_profile_select", { profileId: "missing" });
    expect(invalid.body.result.isError).toBe(true);
    expect((await rpc("browser_profiles_list")).body.result.structuredContent.requestedProfileId).toBe("other");
    expect((await api("POST", `/api/bots/${botId}/stop`)).status).toBe(200);
    expect((await api("POST", "/api/internal/browser/mcp", { method: "tools/call", params: { name: "browser_profiles_list", arguments: {} } }, token)).status).toBe(401);
  }, 30_000);
});
