// A bot turn through the whole app: a Legion server fixture, a ZCode instance on the real ZCode server and a
// loopback model stand-in. Proves interim assistant text reaches the bot's thread while its turn is still
// running. Opt-in like zcode-server.e2e.test.ts: set OMB_ZCODE_SERVER_E2E_ROOT to an official server folder.
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";
import { startFakeAnthropicProvider, type FakeAnthropicProvider } from "./testing/fake-anthropic-provider.ts";

const ROOT = process.env.OMB_ZCODE_SERVER_E2E_ROOT;

describe.skipIf(ROOT === undefined)("interim ZCode text on a real bot turn (real ZCode server, fake model)", () => {
  let fixture: VerificationServer;
  let provider: FakeAnthropicProvider;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };

  beforeAll(async () => {
    // Long enough after the interim sentence for the test to look at the thread mid-turn.
    provider = await startFakeAnthropicProvider({ finalDelayMs: 6000, textDelayMs: 100 });
    fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, ["zcode"]);
    const home = fixture.info.dataDir;
    mkdirSync(join(home, "tools", "zcode-server"), { recursive: true });
    symlinkSync(ROOT!, join(home, "tools", "zcode-server", "current"));
    mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
    writeFileSync(join(home, ".zcode", "v2", "provider_config.json"), JSON.stringify({
      schemaVersion: 1,
      config: {
        providerOrder: ["fake"],
        providerConfigRules: { providerRules: [{ providerId: "fake", providerName: "Fake", config: {
          group: "standard-personal",
          access: { type: "api-key", apiKey: "test-key" },
          api: { type: "anthropic-messages", baseUrl: `http://127.0.0.1:${provider.port}` },
          personalModelIds: ["fake-model"],
          modelOrder: ["fake-model"],
        } }] },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      },
    }));
    // Reloading the instance picks up the personal provider and the server.
    expect((await api("PATCH", "/api/instances/zcode", { server: true })).status).toBe(200);
    expect((await api("POST", "/api/instances/zcode/refresh-models", {})).status).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await fixture?.close();
    await provider?.close();
  }, 60_000);

  it("shows the interim sentence in the bot's thread before the turn ends", async () => {
    const catalog = (await api("GET", "/api/instances")).body.instances.find((instance: any) => instance.instanceId === "zcode");
    const model = catalog.models.options.find((option: any) => option.id.startsWith("fake/fake-model")).id;
    const bot = (await api("POST", "/api/bots", { name: "Narrator", modelSelection: { instanceId: "zcode", model } })).body.bot;
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "narrate" })).status).toBe(202);

    const texts = async () => {
      const current = (await api("GET", "/api/bots?messages=50")).body.bots.find((candidate: any) => candidate.id === bot.id);
      return { busy: current.busy as boolean, replies: (current.messages as any[]).filter((message) => message.role === "bot" && typeof message.text === "string" && message.text.trim()).map((message) => message.text as string) };
    };
    // The interim sentence appears while the bot is still busy: the stand-in holds its closing answer back for 6 s.
    await expect.poll(async () => (await texts()).replies.includes("Checking the files first."), { timeout: 90_000, interval: 250 }).toBe(true);
    const midTurn = await texts();
    expect(midTurn.busy).toBe(true);
    expect(midTurn.replies).not.toContain("All done.");

    await expect.poll(async () => (await texts()).busy, { timeout: 90_000, interval: 500 }).toBe(false);
    const after = (await texts()).replies;
    expect(after.filter((text) => text === "Checking the files first.")).toHaveLength(1);
    expect(after.indexOf("Checking the files first.")).toBeLessThan(after.indexOf("All done."));
  }, 240_000);
});
