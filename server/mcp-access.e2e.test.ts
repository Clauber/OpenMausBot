import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { startFakeHttpMcp } from "./testing/fake-http-mcp-server.ts";

// A stand-in for the gog Gmail/Calendar gateway. The key is a placeholder
// that exists only in this test: the catalog names the variable, the
// fixture's own env file supplies the value, and the stub refuses any other.
const STUB_KEY = "stub-gateway-key-for-test";
const FAKE_NOTES = fileURLToPath(new URL("./testing/fake-mcp-server.ts", import.meta.url));
type Bot = { id: string; mcpServers?: string[] | null };
type Dump = { mcpConfig: { mcpServers: Record<string, { headers?: Record<string, string> }> } };

it("installs a catalog app on first grant, then grants and revokes it per bot for the next turn", async () => {
  const gateway = await startFakeHttpMcp({
    requireHeader: { name: "x-litellm-api-key", value: STUB_KEY },
    tools: [
      { name: "gmail_search", inputSchema: { type: "object" } },
      { name: "calendar_events", inputSchema: { type: "object" } },
    ],
  });
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: "happy" });
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = { status: response.status, body: await response.json() as any };
    evidence.push({ method, path, status: result.status, ...(path.startsWith("/api/auth/") ? {} : { body: result.body }) });
    return result;
  };
  const control = async (args: string[]): Promise<any> => runControlOmb([...args, "--url", fixture.info.url]);
  const turn = async (bot: Bot) => {
    rmSync(fixture.fixtureDumpPath, { force: true });
    await control(["send", "--bot", bot.id, "--text", "Reply briefly."]);
    await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 15_000 }).toBe(true);
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as Dump;
    expect((await control(["wait", "--bot", bot.id, "--timeout", "30"])).status).toBe("settled");
    return Object.keys(dump.mcpConfig.mcpServers).filter((name) => ["notes", "gog", "vault"].includes(name)).sort();
  };
  const toolsOf = async (bot: Bot) => {
    const { status, body } = await api("GET", `/api/bots/${bot.id}/mcp-tools`);
    expect(status).toBe(200);
    return Object.fromEntries((body.servers as Array<{ name: string; ok: boolean; tools: Array<{ name: string }> }>)
      .map((server) => [server.name, server.ok ? server.tools.map((tool) => tool.name).sort() : "failed"]));
  };
  try {
    // The person's own catalog file points gog at the stub; the secret's value
    // lives only in the fixture home's env file, as it would in ~/ai/.env.
    writeFileSync(join(fixture.info.dataDir, "mcp-catalog.json"), JSON.stringify({ entries: [
      { name: "gog", label: "Gmail & Calendar", transport: "http", url: gateway.url, headers: { "x-mcp-servers": "gog" },
        secrets: [{ target: "header", name: "x-litellm-api-key", envKey: "GOG_GATEWAY_KEY" }] },
      { name: "vault", label: "Vault", transport: "http", url: gateway.url,
        secrets: [{ target: "header", name: "x-litellm-api-key", envKey: "VAULT_KEY_NOT_SET" }] },
    ] }));
    mkdirSync(join(fixture.info.dataDir, "ai"), { recursive: true });
    writeFileSync(join(fixture.info.dataDir, "ai", ".env"), `GOG_GATEWAY_KEY=${STUB_KEY}\n`);

    const catalog = (await api("GET", "/api/mcp/catalog")).body.entries as Array<{ name: string; installed: boolean; secrets: Array<{ available: boolean }> }>;
    expect(catalog.find((entry) => entry.name === "gog")).toMatchObject({ installed: false, enabled: false, secrets: [{ name: "x-litellm-api-key", available: true }] });
    expect(catalog.find((entry) => entry.name === "vault")).toMatchObject({ secrets: [{ available: false }] });
    expect(catalog.map((entry) => entry.name)).toContain("grafana");
    expect(JSON.stringify(catalog)).not.toContain(STUB_KEY);

    // One server the person already runs, and two bots that follow "all enabled".
    const imported = await api("POST", "/api/mcp/servers/import", { json: JSON.stringify({ notes: { command: process.execPath, args: ["--experimental-strip-types", FAKE_NOTES] } }) });
    expect(imported.status).toBe(201);
    expect((await api("POST", "/api/mcp/apps/notes/enable", {})).status).toBe(200);
    const { bot: tester } = await control(["new-bot", "--name", "Access tester"]) as { bot: Bot };
    const { bot: bystander } = await control(["new-bot", "--name", "Bystander"]) as { bot: Bot };
    expect(await turn(tester)).toEqual(["notes"]);

    // Granting an app that is not installed: install it, grant nobody else.
    const enabled = await api("POST", "/api/mcp/apps/gog/enable", {});
    expect(enabled.status).toBe(200);
    expect(enabled.body.servers.find((server: { name: string }) => server.name === "gog")).toMatchObject({
      enabled: true, type: "http", url: gateway.url, headerKeys: ["x-litellm-api-key", "x-mcp-servers"],
    });
    expect(JSON.stringify(enabled.body)).not.toContain(STUB_KEY);
    expect(enabled.body.pinned.sort()).toEqual([bystander.id, tester.id].sort());
    const bots = (await api("GET", "/api/bots?messages=0")).body.bots as Bot[];
    expect(bots.find((bot) => bot.id === tester.id)?.mcpServers).toEqual(["notes"]);
    expect(await turn(tester)).toEqual(["notes"]);
    expect(await turn(bystander)).toEqual(["notes"]);
    expect(await toolsOf(tester)).toEqual({ notes: ["read_notes"] });

    // Grant: the next turn mounts it with the secret resolved server-side,
    // and the bot lists the gateway's tools.
    expect((await api("PATCH", `/api/bots/${tester.id}`, { mcpServers: ["notes", "gog"] })).status).toBe(200);
    expect(await turn(tester)).toEqual(["gog", "notes"]);
    expect(await toolsOf(tester)).toEqual({ notes: ["read_notes"], gog: ["calendar_events", "gmail_search"] });
    expect(await toolsOf(bystander)).toEqual({ notes: ["read_notes"] });
    expect(gateway.seenHeaders.some((headers) => headers["x-litellm-api-key"] === STUB_KEY && headers["x-mcp-servers"] === "gog")).toBe(true);

    // Revoke: gone on the next turn, and the server stays installed.
    expect((await api("PATCH", `/api/bots/${tester.id}`, { mcpServers: ["notes"] })).status).toBe(200);
    expect(await turn(tester)).toEqual(["notes"]);
    expect(await toolsOf(tester)).toEqual({ notes: ["read_notes"] });
    const kept = (await api("GET", "/api/mcp/servers")).body.servers as Array<{ name: string; enabled: boolean }>;
    expect(kept.find((server) => server.name === "gog")).toMatchObject({ enabled: true });

    // A secret nobody has yet: refuse and name it, then accept a one-time value.
    const refused = await api("POST", "/api/mcp/apps/vault/enable", {});
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ missing: ["x-litellm-api-key"] });
    expect((await api("GET", "/api/mcp/servers")).body.servers.map((server: { name: string }) => server.name)).not.toContain("vault");
    const typed = await api("POST", "/api/mcp/apps/vault/enable", { secrets: { "x-litellm-api-key": STUB_KEY } });
    expect(typed.status).toBe(200);
    expect(JSON.stringify(typed.body)).not.toContain(STUB_KEY);
    expect((await api("POST", "/api/mcp/apps/not-in-catalog/enable", {})).status).toBe(404);

    // A paired client session may not install or enable anything.
    const opened = await api("POST", "/api/auth/pairing", { scopes: ["client"] });
    const paired = await api("POST", "/api/auth/pair", { code: opened.body.code, label: "Fixture client" });
    expect((await api("POST", "/api/mcp/apps/grafana/enable", {}, { authorization: `Bearer ${paired.body.token}` })).status).toBe(403);
  } finally {
    await fixture.close();
    await gateway.close();
    const evidencePath = `${fixture.info.logPath}.mcp-access.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2).replaceAll(STUB_KEY, "<stub>"));
    expect(existsSync(fixture.info.dataDir)).toBe(false);
    console.info(JSON.stringify({ ...fixture.info, evidencePath, fixtureRemoved: true, dir: dirname(evidencePath) }));
  }
}, 180_000);
