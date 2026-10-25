import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";

describe("the ZCode server switch through an isolated HTTP fixture", () => {
  let fixture: VerificationServer;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const zcode = async () => (await api("GET", "/api/instances")).body.instances.find((instance: any) => instance.driverKind === "zcodeAgent");

  beforeAll(async () => {
    fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, ["zcode"]);
  });
  afterAll(async () => {
    await fixture?.close();
  });

  it("turns server mode on and off for a ZCode instance, and only for ZCode", async () => {
    const instance = await zcode();
    expect(instance).toBeTruthy();
    expect(instance.capabilities.queueing).toBe(false);

    expect((await api("PATCH", `/api/instances/${instance.instanceId}`, { server: true })).status).toBe(200);
    const on = await zcode();
    expect(on.capabilities).toMatchObject({ queueing: true, modelVariants: true });
    expect(on.authentication?.method).toBe("browser-poll");

    expect((await api("PATCH", `/api/instances/${instance.instanceId}`, { server: false })).status).toBe(200);
    const off = await zcode();
    expect(off.capabilities.queueing).toBe(false);
    expect(off.authentication).toBeUndefined();

    const other = (await api("GET", "/api/instances")).body.instances.find((candidate: any) => candidate.driverKind !== "zcodeAgent");
    const refused = await api("PATCH", `/api/instances/${other.instanceId}`, { server: true });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/ZCode instances only/);
  }, 120_000);
});
