import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

it("members can schedule messages but only owners can configure executable prechecks", async () => {
  const fixture = await launchVerificationServer();
  const api = async (method: string, path: string, body?: unknown, status = 200, token?: string) => {
    const response = await fetch(fixture.info.url + path, { method, headers: {
      origin: fixture.info.url, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    const value = await response.json() as any;
    expect(response.status, JSON.stringify(value)).toBe(status);
    return value;
  };
  try {
    const { bot } = await api("POST", "/api/bots", { name: "Authority fixture", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }, 201);
    const { code } = await api("POST", "/api/auth/pairing", { label: "Member fixture", scopes: ["client"] });
    const { token } = await api("POST", "/api/auth/pair", { code });
    const input = { name: "Member schedule", prompt: "Report status", botId: bot.id, enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } };
    const preCheck = { command: process.execPath, args: ["-e", "console.log('{\"items\":[]}')"] };
    await api("POST", "/api/routines", { ...input, preCheck }, 403, token);
    const { routine } = await api("POST", "/api/routines", input, 201, token);
    await api("PATCH", `/api/routines/${routine.id}`, { preCheck }, 403, token);
    await api("PATCH", `/api/routines/${routine.id}`, { preCheck });
    expect((await api("GET", "/api/routines")).routines.find((r: any) => r.id === routine.id).preCheck.command).toBe(process.execPath);
  } finally { await fixture.close(); }
}, 30_000);
