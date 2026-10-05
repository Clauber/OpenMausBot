// ZCode driver contract tests, run against the scripted fake app-server in
// server/testing/fake-zcode-app-server.ts — the driver must drive the
// session/create (or resume) → subscribe → send handshake, normalize
// session/event payloads into canonical events, answer permission and
// user-input asks through request.opened cards, and fail a refused resume
// instead of silently starting a blank session.
//
// The fake is a shebang script — the same constraint the zcode wrapper
// itself hits on Windows. resolveCliSpawn covers both, so these run everywhere.
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProviderInstance, RuntimeEvent } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { ZcodeDriver, zcodeAllowOption, zcodeCatalogFromSnapshot, zcodeConfigModels, zcodeMergePersonalConfigs, zcodeMcpServerParam, zcodeModelId, zcodeParseModelId, zcodePermissionMode, zcodeRequestSummary, zcodeWorkspaceRef } from "./zcode.ts";
import { removeTempDir } from "../testing/cleanup.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-zcode-app-server.ts");

describe("ZcodeDriver config and pure helpers", () => {
  it("defaults the cli and keeps a configured override", () => {
    expect(ZcodeDriver.decodeConfig(undefined)).toEqual({ cli: "zcode" });
    expect(ZcodeDriver.decodeConfig({ cli: "/opt/zcode/bin/zcode" })).toEqual({ cli: "/opt/zcode/bin/zcode" });
    expect(ZcodeDriver.decodeConfig({ cli: "   " })).toEqual({ cli: "zcode" });
  });

  it("maps approval modes onto zcode permission modes", () => {
    expect(zcodePermissionMode("ask")).toBe("build");
    expect(zcodePermissionMode("auto")).toBe("build");
    expect(zcodePermissionMode("edits")).toBe("edit");
    expect(zcodePermissionMode("full")).toBe("yolo");
  });

  it("derives the workspace ref the CLI's own builder derives: key = identity ?? path", () => {
    expect(zcodeWorkspaceRef("/tmp/fixture")).toEqual({ workspacePath: "/tmp/fixture", workspaceKey: "/tmp/fixture" });
    expect(zcodeWorkspaceRef("/tmp/fixture", "remote:ssh:host:/tmp/fixture")).toEqual({
      workspacePath: "/tmp/fixture",
      workspaceKey: "remote:ssh:host:/tmp/fixture",
      workspaceIdentity: "remote:ssh:host:/tmp/fixture",
    });
    // A blank identity falls back to the path, like buildWorkspaceRef.
    expect(zcodeWorkspaceRef("/tmp/fixture", "  ").workspaceKey).toBe("/tmp/fixture");
  });

  it("formats and parses model ids in the CLI's picker shape, including reasoning levels", () => {
    expect(zcodeModelId({ providerId: "zai", modelId: "glm-5" })).toBe("zai/glm-5");
    expect(zcodeModelId({ providerId: "zai", modelId: "glm-5" }, "max")).toBe("zai/glm-5$max");
    expect(zcodeModelId({ providerId: "", modelId: "glm-5" })).toBeNull();
    expect(zcodeParseModelId("zai/glm-5")).toEqual({ providerId: "zai", modelId: "glm-5" });
    expect(zcodeParseModelId("zai/glm-5$max")).toEqual({ providerId: "zai", modelId: "glm-5", options: { reasoningLevel: "max" } });
    // Personal model ids may carry their own slashes; the provider ends at
    // the first slash.
    expect(zcodeParseModelId("prov/kiro/claude-opus-5")).toEqual({ providerId: "prov", modelId: "kiro/claude-opus-5" });
    expect(zcodeParseModelId("agent-default")).toBeNull();
    expect(zcodeParseModelId("no-slash")).toBeNull();
    expect(zcodeParseModelId("zai/glm-5$")).toBeNull();
  });

  it("merges every personal provider config into one candidate set", () => {
    const merged = zcodeMergePersonalConfigs([
      {
        config: {
          providerOrder: ["zai-fake", "deepseek"],
          providerConfigRules: { providerRules: [
            { providerId: "zai-fake", providerName: "Z.AI Fake", config: { personalModelIds: ["glm-5"], modelOrder: ["glm-5"] } },
          ] },
          modelConfigRules: { providerModelRules: [
            { providerId: "zai-fake", modelId: "glm-5", config: { properties: { contextWindow: 200000 } } },
          ] },
        },
      },
      {
        config: {
          providerOrder: ["deepseek", "zai-fake"],
          providerConfigRules: { providerRules: [
            { providerId: "deepseek", providerName: "DeepSeek", enabled: true, config: { personalModelIds: ["deepseek-chat"] } },
            { providerId: "zai-fake", providerName: "Duplicate ignored", config: { personalModelIds: ["other"] } },
          ] },
          modelConfigRules: { providerModelRules: [] },
        },
      },
    ]);
    expect(zcodeConfigModels(merged!)).toEqual([
      { providerId: "zai-fake", providerName: "Z.AI Fake", modelId: "glm-5", contextWindow: 200000 },
      { providerId: "deepseek", providerName: "DeepSeek", modelId: "deepseek-chat" },
    ]);
    // A disabled provider offers nothing.
    const disabled = zcodeMergePersonalConfigs([{
      config: { providerConfigRules: { providerRules: [
        { providerId: "off", providerName: "Off", enabled: false, config: { personalModelIds: ["m"] } },
      ] }, modelConfigRules: { providerModelRules: [] } },
    }]);
    expect(zcodeConfigModels(disabled!)).toEqual([]);
    expect(zcodeMergePersonalConfigs([])).toBeNull();
  });

  it("builds the catalog from a snapshot's settings state, current selection first", () => {
    const catalog = zcodeCatalogFromSnapshot({
      model: {
        current: { providerId: "zai-fake", modelId: "glm-5.3-flash", options: { reasoningLevel: "max" } },
        available: [
          {
            ref: { providerId: "zai-fake", modelId: "glm-5.3-flash" },
            label: "glm-5.3-flash",
            contextWindow: 200000,
            reasoning: { levels: [{ value: "low" }, { value: "max" }], defaultLevel: "max" },
          },
        ],
      },
    });
    expect(catalog.default).toBe("zai-fake/glm-5.3-flash$max");
    expect(catalog.options[0]).toMatchObject({ id: "zai-fake/glm-5.3-flash$max", label: "glm-5.3-flash", contextWindow: 200000 });
    // No settings → the passthrough fallback, never an empty catalog.
    expect(zcodeCatalogFromSnapshot({}).default).toBe("agent-default");
  });

  it("mounts stdio and remote MCP servers in the protocol's shapes", () => {
    expect(zcodeMcpServerParam("agents", { command: "node", args: ["proxy.mjs"], env: { TOKEN: "t" } })).toEqual({
      name: "agents",
      command: "node",
      args: ["proxy.mjs"],
      env: [{ name: "TOKEN", value: "t" }],
    });
    expect(zcodeMcpServerParam("notes", { type: "http", url: "https://example.test/notes", headers: { authorization: "Bearer t" } })).toEqual({
      name: "notes",
      type: "http",
      url: "https://example.test/notes",
      headers: [{ name: "authorization", value: "Bearer t" }],
    });
  });

  it("answers Full access only through an allow option the CLI itself offered", () => {
    const options = {
      options: [
        { optionId: "d", response: { decision: "deny" } },
        { optionId: "a", response: { decision: "allow" } },
      ],
    };
    expect(zcodeAllowOption(options)).toEqual({ decision: "allow" });
    expect(zcodeAllowOption({ options: [{ optionId: "d", response: { decision: "deny" } }] })).toBeNull();
    expect(zcodeAllowOption({})).toBeNull();
  });

  it("builds the permission card from the request's command input, falling back to the reason", () => {
    const withCommand = zcodeRequestSummary({ toolName: "Bash", reason: "needs approval", input: { command: "ls -la", cwd: "/tmp" } });
    expect(withCommand.tool).toBe("Bash");
    expect(withCommand.summary).toContain("ls -la");
    expect(withCommand.command).toEqual({ command: "ls -la", cwd: "/tmp" });
    const withoutCommand = zcodeRequestSummary({ toolName: "WebFetch", reason: "network", input: { url: "https://x" } });
    expect(withoutCommand.summary).toBe("network");
    expect(withoutCommand.command).toBeUndefined();
  });
});

describe("ZcodeDriver turns (fake app-server)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;
  const dumps: string[] = [];

  const create = async (opts: { mode?: string } = {}) => {
    if (opts.mode) process.env.FAKE_ZCODE_MODE = opts.mode;
    instance = await ZcodeDriver.create({
      instanceId: "zcode-test",
      displayName: "ZCode Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI },
    });
    recorder = recordEvents(instance.adapter);
  };

  const newDump = () => {
    const path = join(scratch, `dump-${dumps.length}.json`);
    process.env.FAKE_ZCODE_DUMP = path;
    dumps.push(path);
    return path;
  };

  beforeEach(() => {
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-zcode-test-"));
    delete process.env.FAKE_ZCODE_MODE;
    delete process.env.FAKE_ZCODE_DUMP;
  });

  afterEach(() => {
    delete process.env.FAKE_ZCODE_MODE;
    delete process.env.FAKE_ZCODE_DUMP;
    recorder?.stop();
    void instance?.adapter.stopAll();
    removeTempDir(scratch);
  });

  it("drives the create → subscribe → send handshake and normalizes the scripted turn", async () => {
    const dump = newDump();
    await create();
    const cwd = scratch;
    const { turnId } = await instance.adapter.sendTurn({ threadId: "happy", text: "Fixture", cwd, system: "You are a fixture bot." });
    const completed = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(completed).toMatchObject({ ok: true, usage: { input: 100, output: 7, cachedInput: 40 } });
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    const methods = seen.calls.map((call: { method: string }) => call.method);
    expect(methods).toEqual(["session/create", "session/setMode", "session/subscribe", "session/send"]);
    expect(seen.calls[0].params.mode).toBe("build");
    expect(seen.calls[0].params.workspace.workspacePath).toBe(cwd);
    expect(seen.calls[0].params.workspace.workspaceKey).toBe(cwd);
    // The persona rides the first prompt of a fresh session.
    expect(seen.calls[3].params.content).toContain("You are a fixture bot.");
    expect(seen.calls[3].params.content).toContain("Fixture");
    expect(seen.calls[3].params.sessionId).toBe("sess_fake_1");
    const kinds = recorder.events.map((event) => event.type);
    expect(kinds).toContain("session.started");
    const deltas = recorder.events.filter((event) => event.type === "content.delta");
    expect(deltas.some((event) => event.streamKind === "reasoning_text" && event.delta === "thinking ")).toBe(true);
    expect(deltas.filter((event) => event.streamKind === "assistant_text").map((event) => event.delta).join("")).toBe("Hello");
    expect(recorder.events).toContainEqual(expect.objectContaining({ type: "item.started", itemType: "tool", itemId: "call_1", title: "Bash" }));
    expect(recorder.events).toContainEqual(expect.objectContaining({ type: "item.completed", itemType: "tool", itemId: "call_1", ok: true }));
    expect(recorder.events).toContainEqual(expect.objectContaining({ type: "item.completed", itemType: "assistant_text", text: "Hello" }));
  });

  it("resumes into the cursor's native session and reasserts the turn's mode", async () => {
    const dump = newDump();
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "resumed", text: "Continue", resumeCursor: "sess_old", approvalMode: "full" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    const methods = seen.calls.map((call: { method: string }) => call.method);
    expect(methods).toEqual(["session/resume", "session/setMode", "session/subscribe", "session/send"]);
    expect(seen.calls[0].params.sessionId).toBe("sess_old");
    expect(seen.calls[1].params.mode).toBe("yolo");
    // A resumed session does not resend the persona.
    expect(seen.calls[3].params.content).toBe("Continue");
  });

  it("fails a refused resume instead of silently starting a blank session", async () => {
    const dump = newDump();
    await create({ mode: "resume-refused" });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "lost", text: "Continue", resumeCursor: "sess_old" });
    const completed = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(completed).toMatchObject({ ok: false });
    expect(recorder.events.some((event) => event.type === "runtime.error")).toBe(true);
    // strictResume: no session/create fallback behind the failed resume.
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.calls.map((c: { method: string }) => c.method)).toEqual(["session/resume"]);
  });

  it("carries a selected model into a fresh session and reasserts it with setModel on resume", async () => {
    const dump = newDump();
    await create();
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "fresh-model",
      text: "Fixture",
      model: "zai-fake/glm-5.3-flash$max",
    });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const fresh = JSON.parse(readFileSync(dump, "utf8"));
    expect(fresh.calls.map((c: { method: string }) => c.method)).toEqual(["session/create", "session/setMode", "session/setModel", "session/subscribe", "session/send"]);
    expect(fresh.calls[0].params.model).toBeUndefined();
    expect(fresh.calls[2].params.model).toEqual({ providerId: "zai-fake", modelId: "glm-5.3-flash", options: { reasoningLevel: "max" } });

    recorder.events.length = 0;
    const dump2 = newDump();
    const { turnId: resumedTurn } = await instance.adapter.sendTurn({
      threadId: "resumed-model",
      text: "Continue",
      resumeCursor: "sess_old",
      model: "zai-fake/glm-5.3-flash$max",
    });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === resumedTurn);
    const resumed = JSON.parse(readFileSync(dump2, "utf8"));
    expect(resumed.calls.map((c: { method: string }) => c.method)).toEqual(["session/resume", "session/setMode", "session/setModel", "session/subscribe", "session/send"]);
    // The reasoning level rides the selection: the registry rejects a
    // level-less selection for models that require one, and create params
    // drop the options entirely — setModel is the only path that honours them.
    expect(resumed.calls[2].params.model).toEqual({ providerId: "zai-fake", modelId: "glm-5.3-flash", options: { reasoningLevel: "max" } });
  });

  it("refuses a turn whose model id is not a provider-qualified selection", async () => {
    newDump();
    await create();
    await expect(instance.adapter.sendTurn({ threadId: "bad-model", text: "Fixture", model: "not-a-model" }))
      .rejects.toThrow(/not a zcode model selection/);
  });

  it("discovers the model catalog from a probe session's snapshot", async () => {
    instance = await ZcodeDriver.create({
      instanceId: "zcode-catalog",
      displayName: "ZCode Catalog",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI },
    });
    recorder = recordEvents(instance.adapter);
    // The probe runs at create(); wait for it to land.
    for (let i = 0; i < 50 && instance.models.default === "agent-default"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(instance.models.default).toBe("zai-fake/glm-5.3-flash$max");
    expect(instance.models.options[0]).toMatchObject({ id: "zai-fake/glm-5.3-flash$max", label: "glm-5.3-flash", contextWindow: 200000 });
  });

  it("echoes the CLI's own allow option under Full access without opening a card", async () => {
    const dump = newDump();
    await create({ mode: "approval" });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "full-approval", text: "Fixture", approvalMode: "full" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(recorder.events.some((event) => event.type === "request.opened")).toBe(false);
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(Object.values(seen.answers)).toContainEqual({ decision: "allow" });
  });

  it("opens a card even under Full access when the CLI offered no allow option, and denies on request", async () => {
    const dump = newDump();
    await create({ mode: "approval-no-allow" });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "fail-closed", text: "Fixture", approvalMode: "full" });
    const opened = (await recorder.until((event) => event.type === "request.opened")) as Extract<RuntimeEvent, { type: "request.opened" }>;
    expect(opened.requestType).toBe("permission");
    expect(opened.summary).toContain("rm -rf");
    const outcome = await instance.adapter.respondToRequest("fail-closed", opened.requestId!, { behavior: "deny" });
    expect(outcome).toBe("rejected");
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(Object.values(seen.answers)).toContainEqual(expect.objectContaining({ decision: "deny" }));
    const resolved = recorder.events.find((event) => event.type === "request.resolved");
    expect(resolved).toMatchObject({ behavior: "deny", source: "user" });
  });

  it("surfaces an Ask-mode permission request as a card and answers allow-once", async () => {
    const dump = newDump();
    await create({ mode: "approval" });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "ask-approval", text: "Fixture", approvalMode: "ask" });
    const opened = (await recorder.until((event) => event.type === "request.opened" && event.requestType === "permission")) as Extract<RuntimeEvent, { type: "request.opened" }>;
    expect(opened.tool).toBe("Bash");
    // The ask carried an exact command with its cwd, so the card carries it too.
    expect(opened.command).toEqual({ command: "ls", cwd: "/tmp" });
    const outcome = await instance.adapter.respondToRequest("ask-approval", opened.requestId!, { behavior: "allow" });
    expect(outcome).toBe("allowed-once");
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(Object.values(seen.answers)).toContainEqual({ decision: "allow" });
  });

  it("routes the engine's structured ask through a question card with choices", async () => {
    const dump = newDump();
    await create({ mode: "question" });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "question", text: "Fixture" });
    const opened = (await recorder.until((event) => event.type === "request.opened" && event.requestType === "question")) as Extract<RuntimeEvent, { type: "request.opened" }>;
    expect(opened.summary).toBe("Pick one");
    expect(opened.choices).toEqual(["alpha", "beta"]);
    const outcome = await instance.adapter.respondToRequest("question", opened.requestId!, { behavior: "answer", message: "alpha" });
    expect(outcome).toBe("answered");
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(Object.values(seen.answers)).toContainEqual(expect.objectContaining({ action: "accept", content: { value: "alpha" } }));
  });

  it("settles a mid-turn crash as a failed turn with the exit attributed", async () => {
    newDump();
    await create({ mode: "exit-mid-turn" });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "crash", text: "Fixture" });
    const completed = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(completed).toMatchObject({ ok: false });
    expect(recorder.events.some((event) => event.type === "runtime.error" && /exited 1/.test(event.message))).toBe(true);
  });
});
