// Contract tests for the ZCode driver. The scripted fake ACP CLI stands in
// for the zcode-acp adapter, so the turn runtime is exercised end to end
// without a real zcode install; the auth probes are checked against the
// filesystem markers the real adapter looks for.
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { ZCodeAgentDriver, zcodeAuthProbe, zcodeModelCatalog, ZCODE_DEFAULT_MODEL_ID } from "./zcode.ts";
import { removeTempDir } from "../../testing/cleanup.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

describe("ZCodeAgentDriver config", () => {
  it("defaults to the zcode-acp adapter and the passthrough model", () => {
    expect(ZCodeAgentDriver.driverKind).toBe("zcodeAgent");
    expect(ZCodeAgentDriver.defaultConfig()).toMatchObject({ cli: "zcode-acp", fullAuto: false });
    expect(ZCodeAgentDriver.models).toEqual({
      default: "zcode-default",
      options: [{ id: "zcode-default", label: "ZCode default (provider config)" }],
    });
    expect(ZCodeAgentDriver.metadata).toMatchObject({
      displayName: "ZCode",
      access: "custom",
      supportsMultipleInstances: true,
    });
  });

  it("keeps a custom adapter command verbatim", () => {
    expect(ZCodeAgentDriver.decodeConfig({ cli: "node /opt/zcode-acp.mjs" })).toMatchObject({
      cli: "node /opt/zcode-acp.mjs",
    });
  });
});

describe("zcodeModelCatalog", () => {
  it("lists every provider-config model as <provider>::<model> plus the passthrough default", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-zcode-catalog-"));
    try {
      const configPath = join(scratch, "provider_config.json");
      writeFileSync(configPath, JSON.stringify({
        schemaVersion: 1,
        config: {
          providerOrder: ["router", "direct"],
          providerConfigRules: { providerRules: [
            { providerId: "router", providerName: "Router", config: { modelOrder: ["cc/claude-opus-5", "glm-5.3"], access: { type: "api-key", apiKey: "k" } } },
            { providerId: "direct", providerName: "Direct", config: { personalModelIds: ["deepseek-chat"] } },
            { providerId: "empty", providerName: "No models", config: {} },
          ] },
        },
      }));
      const catalog = zcodeModelCatalog({ ZCODE_ACP_PROVIDER_CONFIG: configPath });
      expect(catalog.default).toBe(ZCODE_DEFAULT_MODEL_ID);
      expect(catalog.options).toEqual([
        { id: "zcode-default", label: "ZCode default (provider config)", custom: true },
        { id: "router::cc/claude-opus-5", label: "cc/claude-opus-5 · router", custom: true },
        { id: "router::glm-5.3", label: "glm-5.3 · router", custom: true },
        { id: "direct::deepseek-chat", label: "deepseek-chat · direct", custom: true },
      ]);
    } finally {
      await removeTempDir(scratch);
    }
  });

  it("falls back to the passthrough option when no config parses", () => {
    const catalog = zcodeModelCatalog({ ZCODE_ACP_PROVIDER_CONFIG: "/nonexistent/provider_config.json" });
    expect(catalog.options).toEqual([
      { id: "zcode-default", label: "ZCode default (provider config)", custom: true },
    ]);
  });
});

describe("zcodeAuthProbe", () => {
  it("accepts the headless provider config, the stock cli store, or the explicit skip", () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-zcode-auth-"));
    try {
      expect(zcodeAuthProbe({ HOME: scratch })).toBe(false);
      expect(zcodeAuthProbe({ HOME: scratch, ZCODE_ACP_SKIP_AUTH_CHECK: "1" })).toBe(true);

      mkdirSync(join(scratch, ".zcode", "headless"), { recursive: true });
      writeFileSync(join(scratch, ".zcode", "headless", "provider_config.json"), "{}");
      expect(zcodeAuthProbe({ HOME: scratch })).toBe(true);

      const bare = mkdtempSync(join(tmpdir(), "omb-zcode-auth-"));
      try {
        mkdirSync(join(bare, ".zcode", "cli"), { recursive: true });
        expect(zcodeAuthProbe({ HOME: bare })).toBe(true);
      } finally {
        void removeTempDir(bare);
      }
    } finally {
      void removeTempDir(scratch);
    }
  });
});

describe("ZCodeAgentDriver turns (fake adapter CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  const create = async (environment: Record<string, string> = {}) => {
    instance = await ZCodeAgentDriver.create({
      instanceId: "zcode-test",
      displayName: "ZCode Test",
      environment,
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-zcode-test-"));
  });

  afterEach(async () => {
    delete process.env.FAKE_ACP_DUMP;
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  it("runs a full turn through the adapter with canonical events", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-zcode", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toContain("turn.started");
    expect(types).toContain("session.started");
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "zcodeAgent")).toBe(true);
    const text = recorder.events.find((e) => e.type === "item.completed" && (e as { itemType?: string }).itemType === "assistant_text")!;
    expect((text as { text?: string }).text).toBe("hello from fake acp");
  });

  it("passes instance env to the adapter but strips foreign provider keys", async () => {
    process.env.XAI_API_KEY = "xai-should-not-leak";
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    // The fake CLI's dump only records a fixed env allowlist, so the
    // adapter-knob passthrough is asserted via a dumped key.
    await create({ ZCODE_ACP_ZCODE_BIN: "/usr/local/bin/zcode-fixture", MY_AGENT_TOKEN: "tok-123" });
    await instance.adapter.sendTurn({ threadId: "t-zcode-env", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8")) as { env: Record<string, string | undefined> };
    expect(seen.env.MY_AGENT_TOKEN).toBe("tok-123");
    // deny-by-default credential hygiene: the adapter never inherits
    // another provider's billing key
    expect(seen.env.XAI_API_KEY).toBeUndefined();
  });
});
