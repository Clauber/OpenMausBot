// Capability-field contract tests: remoteAgent is the typed replacement for
// the boxAgent composite reads in dispatch and rooms, and usesCloudComputer()
// is derived from the two fields a driver declares (remoteAgent,
// cloudComputerMcp), so no driver can declare it out of step. The fleet
// invariant at the bottom pins remoteAgent to exactly the boat-native driver
// and the derivation for every built-in driver.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import { usesCloudComputer, type ProviderInstance } from "../contracts.ts";
import { BoatAgentDriver } from "./boatagent.ts";
import { BUILT_IN_DRIVERS } from "./builtIn.ts";
import { ClaudeDriver } from "./claude.ts";
import { CodexDriver } from "./codex.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { PiDriver } from "./pi.ts";

const created: ProviderInstance[] = [];
const keep = async (promise: Promise<ProviderInstance>): Promise<ProviderInstance> => {
  const instance = await promise;
  created.push(instance);
  return instance;
};

describe("typed capability fields (remoteAgent / usesCloudComputer)", () => {
  beforeEach(() => {
    ensureDirs();
  });

  afterEach(async () => {
    for (const instance of created.splice(0)) await instance.dispose();
  });

  it("declares the box-native engine remote and cloud-bound without a bridge mount", async () => {
    const boat = await keep(BoatAgentDriver.create({
      instanceId: "caps-box", displayName: "Caps Boat",
      environment: { BOX_TOKEN: "boat-test-token" }, enabled: true, config: { pollMs: 0 },
    }));
    expect(boat.adapter.capabilities.remoteAgent).toBe(true);
    expect(usesCloudComputer(boat.adapter.capabilities)).toBe(true);
    // The agent switches to Boat's model — it never consumes the descriptor,
    // so cloudComputerMcp stays absent (its own contract excludes it).
    expect(boat.adapter.capabilities.cloudComputerMcp).toBeUndefined();
  });

  it("derives usesCloudComputer from cloudComputerMcp on the chat runtime", async () => {
    const mounted = await keep(OpenAICompatDriver.create({
      instanceId: "caps-compat", displayName: "Caps Compat", environment: {}, enabled: true,
      config: OpenAICompatDriver.defaultConfig(),
    }));
    expect(mounted.adapter.capabilities.cloudComputerMcp).toBe(true);
    expect(usesCloudComputer(mounted.adapter.capabilities)).toBe(true);
    expect(mounted.adapter.capabilities.remoteAgent).toBeUndefined();
    // Tools off means the runtime cannot mount the leased descriptor either,
    // so both gates must fall together.
    const bare = await keep(OpenAICompatDriver.create({
      instanceId: "caps-compat-bare", displayName: "Caps Compat Bare", environment: {}, enabled: true,
      config: { ...OpenAICompatDriver.defaultConfig(), tools: false },
    }));
    expect(bare.adapter.capabilities.cloudComputerMcp).toBe(false);
    expect(usesCloudComputer(bare.adapter.capabilities)).toBe(false);
  });

  it("leaves host-harness drivers off the cloud computer", async () => {
    const claude = await keep(ClaudeDriver.create({
      instanceId: "caps-claude", displayName: "Caps Claude", environment: {}, enabled: true,
      config: ClaudeDriver.defaultConfig(),
    }));
    expect(claude.adapter.capabilities.remoteAgent).toBeUndefined();
    expect(usesCloudComputer(claude.adapter.capabilities)).toBe(false);
    const codex = await keep(CodexDriver.create({
      instanceId: "caps-codex", displayName: "Caps Codex", environment: {}, enabled: true,
      config: CodexDriver.defaultConfig(),
    }));
    expect(codex.adapter.capabilities.remoteAgent).toBeUndefined();
    expect(usesCloudComputer(codex.adapter.capabilities)).toBe(false);
    const pi = await keep(PiDriver.create({
      instanceId: "caps-pi", displayName: "Caps Pi", environment: {}, enabled: true,
      config: PiDriver.defaultConfig(),
    }));
    expect(pi.adapter.capabilities.remoteAgent).toBeUndefined();
    expect(usesCloudComputer(pi.adapter.capabilities)).toBe(false);
  });

  it("holds the fleet invariant the swapped reads rely on", async () => {
    for (const driver of BUILT_IN_DRIVERS) {
      const instance = await keep(driver.create({
        instanceId: `caps-fleet-${driver.driverKind}`, displayName: "Caps Fleet", environment: {}, enabled: true,
        config: driver.driverKind === "customAcp" ? { cli: "echo" } : {},
      }));
      const caps = instance.adapter.capabilities;
      // remoteAgent is exactly the boat-native driver: this biconditional is
      // what lets every former driverKind === "boxAgent" capability read
      // become caps.remoteAgent === true without changing an outcome.
      expect(caps.remoteAgent === true, driver.driverKind).toBe(driver.driverKind === "boxAgent");
      // The attach and readiness sites read one derivation: a driver runs
      // on the cloud computer natively or by mounting its descriptor.
      expect(usesCloudComputer(caps), driver.driverKind)
        .toBe(caps.remoteAgent === true || caps.cloudComputerMcp === true);
      expect(caps, driver.driverKind).not.toHaveProperty("usesCloudComputer");
    }
  });
});
