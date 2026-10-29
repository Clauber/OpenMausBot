// ZCode driver contract tests, run against the scripted fake app-server in
// server/testing/fake-zcode-app-server.ts. CLI turns run over ZCode Protocol
// v4 through @clauber/zcode-adapter.
//
// The fake is a shebang script — the same constraint the zcode wrapper
// itself hits on Windows. resolveCliSpawn covers both, so these run everywhere.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { DATA_DIR } from "../config.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderInstance, RuntimeEvent } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { ZcodeDriver, zcodeAllowOption, zcodeBotHomeEnv, zcodeCatalogFromSnapshot, zcodeConfigModels, zcodeMergePersonalConfigs, zcodeMcpServerParam, zcodeModelId, zcodeParseModelId, zcodePermissionMode, zcodeWorkspaceRef } from "./zcode.ts";
import { zcodeRequestSummary } from "./zcode-stdio-turn.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { CONTINUATION_NUDGE } from "./announced-action.ts";
import { ZCODE_MAX_TURN_RESUMES, ZCODE_RESUME_PROMPT } from "./zcode-turn-recovery.ts";

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
    const always = { optionId: "allowAlways", kind: "allowAlways", response: { decision: "allow" } };
    const once = { optionId: "allowOnce", kind: "allowOnce", response: { decision: "allow" } };
    expect(zcodeAllowOption({ options: [always, once] })).toBe(once.response);
    expect(zcodeAllowOption({ options: [always] })).toBeNull();
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

const writePersonalSetup = (home: string) => {
  mkdirSync(join(home, ".zcode", "server"), { recursive: true });
  mkdirSync(join(home, ".zcode", "cli"), { recursive: true });
  writeFileSync(join(home, ".zcode", "cli", "config.json"), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo sentinel-hook" }] }] },
    mcp: { servers: { "sentinel-mcp": { command: "sentinel-mcp" } } },
  }));
  writeFileSync(join(home, ".zcode", "AGENTS.md"), "sentinel personal instructions");
};

describe.skipIf(process.platform === "win32")("zcodeBotHomeEnv", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "omb-zcode-home-"));
  });
  afterEach(() => removeTempDir(root));

  it("links only the runtime and anchors credentials and the session DB on the source home", () => {
    const source = join(root, "source");
    const bot = join(root, "bot");
    writePersonalSetup(source);
    const expected = {
      HOME: bot,
      ZCODE_DATA_BASE_DIR: source,
      ZCODE_SESSION_DB_PATH: join(source, ".zcode", "cli", "db", "db.sqlite"),
    };
    expect(zcodeBotHomeEnv({}, source, bot)).toEqual(expected);
    expect(realpathSync(join(bot, ".zcode", "server"))).toBe(realpathSync(join(source, ".zcode", "server")));
    expect(existsSync(join(bot, ".zcode", "cli", "config.json"))).toBe(false);
    expect(existsSync(join(bot, ".zcode", "AGENTS.md"))).toBe(false);
    expect(zcodeBotHomeEnv({}, source, bot)).toEqual(expected);
  });

  it("keeps user-config storage overrides and explicit env, resolving ~ against the source home", () => {
    const source = join(root, "source");
    mkdirSync(join(source, ".zcode", "cli"), { recursive: true });
    writeFileSync(join(source, ".zcode", "cli", "config.json"), JSON.stringify({ storage: { dir: "~/zstore", sessionDbPath: "~/zdb/db.sqlite" } }));
    expect(zcodeBotHomeEnv({}, source, join(root, "bot"))).toMatchObject({
      ZCODE_STORAGE_DIR: join(source, "zstore"),
      ZCODE_SESSION_DB_PATH: join(source, "zdb", "db.sqlite"),
    });
    expect(zcodeBotHomeEnv({
      ZCODE_STORAGE_DIR: "/srv/zcode-store",
      ZCODE_SESSION_DB: "~/alias/db.sqlite",
      ZCODE_DATA_BASE_DIR: "/srv/zcode-base",
    }, source, join(root, "bot"))).toMatchObject({
      ZCODE_STORAGE_DIR: "/srv/zcode-store",
      ZCODE_SESSION_DB_PATH: join(source, "alias", "db.sqlite"),
      ZCODE_DATA_BASE_DIR: "/srv/zcode-base",
    });
  });

  it("repoints a stale runtime link and fails when the link path is occupied", () => {
    const source = join(root, "source");
    const bot = join(root, "bot");
    mkdirSync(join(source, ".zcode", "server"), { recursive: true });
    mkdirSync(join(bot, ".zcode"), { recursive: true });
    symlinkSync(join(root, "gone"), join(bot, ".zcode", "server"), "dir");
    zcodeBotHomeEnv({}, source, bot);
    expect(realpathSync(join(bot, ".zcode", "server"))).toBe(realpathSync(join(source, ".zcode", "server")));

    const occupied = join(root, "occupied");
    mkdirSync(join(occupied, ".zcode", "server"), { recursive: true });
    expect(() => zcodeBotHomeEnv({}, source, occupied)).toThrow();
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

  type Dump = { calls: Array<{ method: string; params: any }>; answers: Record<string, unknown>; v1Replies: Record<string, unknown>; env: Record<string, string> };
  /** The wire steps a turn took: v4 commands by type, other requests by method. */
  const stepsOf = (seen: Dump) => seen.calls
    .map((call) => call.method === "v4/command" ? call.params.type : call.method)
    .filter((step) => !step.startsWith("v4/attachment/") && step !== "v4/conversation/unsubscribe");
  const commandsOf = (seen: Dump, type: string) => seen.calls.filter((call) => call.method === "v4/command" && call.params.type === type).map((call) => call.params);
  const commandOf = (seen: Dump, type: string) => commandsOf(seen, type)[0];

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

  it("drives the v4 create → subscribe → sendText handshake and normalizes the scripted turn", async () => {
    const dump = newDump();
    await create();
    const cwd = scratch;
    const { turnId } = await instance.adapter.sendTurn({ threadId: "happy", text: "Fixture", cwd, system: "You are a fixture bot." });
    const completed = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(completed).toMatchObject({ ok: true, usage: { input: 100, output: 7, cachedInput: 40 } });
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(stepsOf(seen)).toEqual(["createSession", "v4/conversation/subscribe", "sendText"]);
    expect(commandOf(seen, "createSession")).toMatchObject({ sessionId: null, payload: { workspaceId: cwd, config: { mode: "build" } } });
    const send = commandOf(seen, "sendText");
    expect(send.sessionId).toBe("sess_fake_1");
    expect(send.payload.mode).toBe("build");
    // The persona rides the first prompt of a fresh session.
    expect(send.payload.text).toContain("You are a fixture bot.");
    expect(send.payload.text).toContain("Fixture");
    expect(recorder.events).toContainEqual(expect.objectContaining({ type: "session.started", sessionId: "sess_fake_1" }));
    const kinds = recorder.events.map((event) => event.type);
    expect(kinds).toContain("session.started");
    const deltas = recorder.events.filter((event) => event.type === "content.delta");
    expect(deltas.some((event) => event.streamKind === "reasoning_text" && event.delta === "thinking ")).toBe(true);
    expect(deltas.filter((event) => event.streamKind === "assistant_text").map((event) => event.delta).join("")).toBe("Hello");
    // One chip per call, and a failed call settles as failed.
    const started = recorder.events.filter((event) => event.type === "item.started" && event.itemType === "tool");
    expect(started.map((event) => event.type === "item.started" && event.itemId)).toEqual(["call_1", "call_2"]);
    expect(started[0]).toMatchObject({ title: "Bash", summary: "ls" });
    expect(started[0].type === "item.started" && started[0].input).toContain("/tmp");
    expect(started[1].type === "item.started" && started[1].input).toContain("/tmp/missing");
    expect(recorder.events).toContainEqual(expect.objectContaining({ type: "item.completed", itemType: "tool", itemId: "call_1", ok: true }));
    expect(recorder.events).toContainEqual(expect.objectContaining({ type: "item.completed", itemType: "tool", itemId: "call_2", ok: false, output: expect.stringContaining("no such file") }));
    expect(recorder.events).toContainEqual(expect.objectContaining({ type: "item.completed", itemType: "assistant_text", text: "Hello" }));
  });

  it("seals each assistant segment where it ends, so interim text reaches the thread mid-turn", async () => {
    newDump();
    await create({ mode: "narrate" });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "narrate", text: "Fixture", cwd: scratch });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const events = recorder.events;
    const sealed = events.flatMap((event, index) => event.type === "item.completed" && event.itemType === "assistant_text" ? [{ index, text: event.text }] : []);
    // Three messages, three items, none repeated at turn.completed.
    expect(sealed.map((item) => item.text)).toEqual(["Checking the files.", "Found two.", "Done."]);
    const at = (predicate: (event: RuntimeEvent) => boolean) => events.findIndex(predicate);
    // The announcement is sealed when the command's block starts, before the command finishes.
    expect(sealed[0]!.index).toBeLessThan(at((event) => event.type === "item.completed" && event.itemType === "tool"));
    // A new assistant message seals the previous one.
    expect(sealed[1]!.index).toBeLessThan(at((event) => event.type === "content.delta" && event.delta === " Done."));
    expect(sealed[2]!.index).toBeLessThan(at((event) => event.type === "turn.completed"));
  });

  it.each([undefined, { allow: ["native:*", "mcp:notes:read", "mcp:agents:*", "mcp:browser:*"] }])("mounts custom integrations through private discovery while preserving builtins and scope %j", async toolScope => {
    const dump = newDump();
    await create();
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "discovery", text: "Fixture", cwd: scratch, toolScope,
      integrations: {
        agents: { command: "agents-fixture", args: [], env: {} },
        browser: { command: "browser-fixture", args: [], env: {} },
        custom: { notes: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "fixture-secret" } } },
      },
    });
    await recorder.until(event => event.type === "turn.completed" && event.turnId === turnId);
    const mounts = commandOf(JSON.parse(readFileSync(dump, "utf8")), "createSession").payload.mcpServers;
    const notes = mounts.find((mount: { name: string }) => mount.name === "notes");
    expect(notes.command).toBe(process.execPath);
    expect(notes.args[0]).toContain("mcp-gate");
    const privateConfig = JSON.parse(notes.env.find((entry: { name: string }) => entry.name === notes.args[2]).value);
    expect(privateConfig.OMB_GATE_DISCOVERY).toBe("1");
    expect(privateConfig.OMB_GATE_TOOL_SCOPE === undefined ? undefined : JSON.parse(privateConfig.OMB_GATE_TOOL_SCOPE)).toEqual(toolScope);
    const upstream = JSON.parse(privateConfig.OMB_GATE_UPSTREAM);
    expect(upstream.args[0]).toContain("mcp-remote");
    expect(JSON.parse(upstream.env.OMB_REMOTE_MCP_SERVER).headers.Authorization).toBe("fixture-secret");
    expect(notes.args.join(" ")).not.toContain("fixture-secret");
    for (const name of ["agents", "browser"]) {
      const builtin = mounts.find((mount: { name: string }) => mount.name === name);
      if (!toolScope) expect(builtin.command).toBe(name + "-fixture");
      else expect(JSON.parse(builtin.env.find((entry: { name: string }) => entry.name === builtin.args[2]).value).OMB_GATE_DISCOVERY).toBeUndefined();
    }
  });

  it.skipIf(process.platform === "win32")("keeps the workspace's own and the user's ZCode MCP servers next to the harness's, which win by name", async () => {
    const dump = newDump();
    await create();
    const project = join(scratch, "project");
    mkdirSync(join(project, ".zcode"), { recursive: true });
    mkdirSync(join(project, ".git"));
    writeFileSync(join(project, ".zcode", "config.json"), JSON.stringify({ mcp: { servers: {
      "project-notes": { type: "http", url: "https://example.com/project" },
      agents: { command: "shadowed-agents" },
    } } }));
    // The CLI runs with the bot home as HOME, so its user scope is the bot home's ZCode config.
    const userConfig = join(DATA_DIR, "providers", "zcode", createHash("sha256").update("zcode-test").digest("hex"), "home", ".zcode", "cli", "config.json");
    mkdirSync(dirname(userConfig), { recursive: true });
    writeFileSync(userConfig, JSON.stringify({ mcp: { servers: { "user-notes": { command: "user-notes-fixture" } } } }));
    try {
      const { turnId } = await instance.adapter.sendTurn({
        threadId: "file-mcp", text: "Fixture", cwd: project,
        integrations: { agents: { command: "agents-fixture", args: [], env: {} } },
      });
      await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    } finally {
      rmSync(userConfig);
    }
    const mounts = commandOf(JSON.parse(readFileSync(dump, "utf8")), "createSession").payload.mcpServers;
    expect(mounts.map((mount: { name: string }) => mount.name).sort()).toEqual(["agents", "project-notes", "user-notes"]);
    expect(mounts.find((mount: { name: string }) => mount.name === "agents").command).toBe("agents-fixture");
    expect(mounts.find((mount: { name: string }) => mount.name === "project-notes")).toMatchObject({ type: "http", url: "https://example.com/project" });
  });

  it("says so and keeps the harness's servers when the workspace's ZCode MCP config cannot be read", async () => {
    const dump = newDump();
    await create();
    mkdirSync(join(scratch, ".zcode"), { recursive: true });
    writeFileSync(join(scratch, ".zcode", "config.json"), "{ not json");
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "broken-mcp", text: "Fixture", cwd: scratch,
      integrations: { agents: { command: "agents-fixture", args: [], env: {} } },
    });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(recorder.events).toContainEqual(expect.objectContaining({ type: "runtime.notice", message: expect.stringContaining("config.json") }));
    const mounts = commandOf(JSON.parse(readFileSync(dump, "utf8")), "createSession").payload.mcpServers;
    expect(mounts.map((mount: { name: string }) => mount.name)).toEqual(["agents"]);
  });

  it("uploads pasted images as native v4 attachments, even with no text", async () => {
    const dump = newDump();
    await create();
    const path = join(scratch, "shot.png");
    writeFileSync(path, Buffer.from("not-a-real-png"));
    const { turnId } = await instance.adapter.sendTurn({ threadId: "image", text: "", images: [{ path, mime: "image/png", bytes: 14 }] });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const seen = JSON.parse(readFileSync(dump, "utf8")) as Dump;
    const begin = seen.calls.find((call) => call.method === "v4/attachment/begin")!;
    expect(begin.params).toMatchObject({ sessionId: "sess_fake_1", fileName: "shot.png", mime: "image/png", totalBytes: 14 });
    const chunk = seen.calls.find((call) => call.method === "v4/attachment/chunk")!;
    expect(Buffer.from(chunk.params.dataBase64, "base64").toString()).toBe("not-a-real-png");
    expect(commandOf(seen, "sendText").payload.attachments).toEqual([
      { ref: `zcode-artifact://sess_fake_1/upload-${begin.params.uploadId}`, fileName: "shot.png", mime: "image/png", bytes: 14 },
    ]);
    expect(instance.adapter.capabilities).toMatchObject({ images: true, nativeImageInput: true });
  });

  it.each([undefined, "sess_old"])("continues an announced action in the same session (cursor %s)", async (resumeCursor) => {
    const dump = newDump();
    await create({ mode: "announce" });
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "announce", text: "Run the tests", resumeCursor, approvalMode: "full", model: "zai-fake/glm-5.3-flash$max",
    });
    const completed = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(completed).toMatchObject({ ok: true, usage: { input: 200, output: 14, cachedInput: 80 } });
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    const sends = commandsOf(seen, "sendText");
    expect(sends).toHaveLength(2);
    expect(sends[1].sessionId).toBe(sends[0].sessionId);
    expect(sends[1].payload).toEqual({ text: CONTINUATION_NUDGE, mode: "yolo" });
    expect(stepsOf(seen).filter((step) => step === "session/resume" || step === "createSession")).toHaveLength(1);
    expect(recorder.events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    expect(recorder.events).toContainEqual(expect.objectContaining({ type: "item.completed", text: `Done — received: ${CONTINUATION_NUDGE}` }));
  });

  it.each([
    ["announce-twice", 2, true, null],
    ["announce-cancelled", 1, true, "interrupted"],
    ["reply-question", 1, true, null],
    ["reply-long", 1, true, null],
    ["announce-rejected", 2, false, "continuation_failed"],
  ])("bounds or skips continuation for %s", async (mode, sends, ok, stopReason) => {
    const dump = newDump();
    await create({ mode: mode as string });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "bounded", text: "Run the tests" });
    const completed = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(completed).toMatchObject({ ok, stopReason });
    expect(commandsOf(JSON.parse(readFileSync(dump, "utf8")), "sendText")).toHaveLength(sends);
    expect(recorder.events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
  });

  it("resumes into the cursor's native session with its MCP servers and sends the turn's mode with the input", async () => {
    const dump = newDump();
    await create();
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "resumed", text: "Continue", resumeCursor: "sess_old", approvalMode: "full", cwd: scratch, system: "You are a fixture bot.",
      integrations: { agents: { command: "agents-fixture", args: [], env: {} } },
    });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(stepsOf(seen)).toEqual(["session/resume", "v4/conversation/subscribe", "sendText"]);
    // A v4 cold resume drops the servers the session was created with (measured on 0.16.9), so v1 resume re-sends them.
    expect(seen.calls[0].params).toMatchObject({ sessionId: "sess_old", workspace: { workspacePath: scratch, workspaceKey: scratch } });
    expect(seen.calls[0].params.mcpServers.map((server: { name: string }) => server.name)).toEqual(["agents"]);
    expect(seen.calls[1].params.topic).toBe("conversation/sess_old");
    // A resumed session does not resend the persona.
    expect(commandOf(seen, "sendText").payload).toEqual({ text: "Continue", mode: "yolo" });
  });

  it("fails a refused resume instead of silently starting a blank session", async () => {
    const dump = newDump();
    await create({ mode: "resume-refused" });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "lost", text: "Continue", resumeCursor: "sess_old" });
    const completed = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(completed).toMatchObject({ ok: false });
    expect(recorder.events.some((event) => event.type === "runtime.error")).toBe(true);
    // strictResume: no createSession fallback behind the failed resume.
    expect(stepsOf(JSON.parse(readFileSync(dump, "utf8")))).toEqual(["session/resume"]);
  });

  it("switches a fresh or resumed session to the selected model without the v1 setModel that rewrites the workspace default", async () => {
    const dump = newDump();
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "fresh-model", text: "Fixture", model: "zai-fake/glm-5.3-flash$low" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const fresh = JSON.parse(readFileSync(dump, "utf8"));
    expect(stepsOf(fresh)).toEqual(["createSession", "v4/conversation/subscribe", "switchModelConfig", "sendText"]);
    expect(commandOf(fresh, "switchModelConfig").payload).toEqual({ provider: "zai-fake", model: "glm-5.3-flash", thought: "low" });

    recorder.events.length = 0;
    const dump2 = newDump();
    const { turnId: resumedTurn } = await instance.adapter.sendTurn({ threadId: "resumed-model", text: "Continue", resumeCursor: "sess_old", model: "zai-fake/glm-5.3-flash$low" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === resumedTurn);
    const resumed = JSON.parse(readFileSync(dump2, "utf8"));
    expect(stepsOf(resumed)).toEqual(["session/resume", "v4/conversation/subscribe", "switchModelConfig", "sendText"]);

    recorder.events.length = 0;
    const dump3 = newDump();
    const { turnId: sameTurn } = await instance.adapter.sendTurn({ threadId: "same-model", text: "Fixture", model: "zai-fake/glm-5.3-flash" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === sameTurn);
    // A bare id on the session's current model keeps its level: nothing to switch.
    expect(stepsOf(JSON.parse(readFileSync(dump3, "utf8")))).toEqual(["createSession", "v4/conversation/subscribe", "sendText"]);
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

  it("keeps the server up and the fallback catalog when the zcode CLI is not installed", async () => {
    const failures: string[] = [];
    const logged = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { failures.push(args.map(String).join(" ")); });
    try {
      instance = await ZcodeDriver.create({
        instanceId: "zcode-missing",
        displayName: "ZCode Missing",
        environment: {},
        enabled: true,
        config: { cli: join(tmpdir(), "omb-no-such-zcode-cli") },
      });
      await vi.waitFor(() => expect(failures.some(line => line.includes("model catalog probe failed") && line.includes("ENOENT"))).toBe(true), { timeout: 10_000 });
      expect(instance.models.default).toBe("agent-default");
    } finally { logged.mockRestore(); }
  });

  it("allows once under Full access without a card, never always, and never answers the v1 ask", async () => {
    const dump = newDump();
    await create({ mode: "approval" });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "full-approval", text: "Fixture", approvalMode: "full" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(recorder.events.some((event) => event.type === "request.opened")).toBe(false);
    const seen = JSON.parse(readFileSync(dump, "utf8")) as Dump;
    expect(Object.values(seen.answers)).toEqual([{ optionId: "allowOnce" }]);
    expect(seen.v1Replies).toEqual({});
  });

  it("opens a card under Full access when the only allow option is allowAlways, and denies on request", async () => {
    const dump = newDump();
    await create({ mode: "approval-no-allow" });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "fail-closed", text: "Fixture", approvalMode: "full" });
    const opened = (await recorder.until((event) => event.type === "request.opened")) as Extract<RuntimeEvent, { type: "request.opened" }>;
    expect(opened.requestType).toBe("permission");
    expect(opened.summary).toContain("rm -rf");
    const outcome = await instance.adapter.respondToRequest("fail-closed", opened.requestId!, { behavior: "deny", message: "Not that one" });
    expect(outcome).toBe("rejected");
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const seen = JSON.parse(readFileSync(dump, "utf8")) as Dump;
    expect(Object.values(seen.answers)).toEqual([{ optionId: "deny", freeText: "Not that one" }]);
    expect(recorder.events.find((event) => event.type === "request.resolved")).toMatchObject({ behavior: "deny", source: "user" });
  });

  it("opens one card for an Ask-mode permission ask however often it is re-announced, and allows once", async () => {
    const dump = newDump();
    await create({ mode: "approval" });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "ask-approval", text: "Fixture", approvalMode: "ask" });
    const opened = (await recorder.until((event) => event.type === "request.opened" && event.requestType === "permission")) as Extract<RuntimeEvent, { type: "request.opened" }>;
    expect(opened.tool).toBe("Bash");
    // The ask carried an exact command with its cwd, so the card carries it too.
    expect(opened.command).toEqual({ command: "ls", cwd: "/tmp" });
    // The fake re-announces the v1 ask every 30 ms while it is pending.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(recorder.events.filter((event) => event.type === "request.opened")).toHaveLength(1);
    const outcome = await instance.adapter.respondToRequest("ask-approval", opened.requestId!, { behavior: "allow" });
    expect(outcome).toBe("allowed-once");
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const seen = JSON.parse(readFileSync(dump, "utf8")) as Dump;
    expect(Object.values(seen.answers)).toEqual([{ optionId: "allowOnce" }]);
    expect(seen.v1Replies).toEqual({});
    expect(recorder.events.filter((event) => event.type === "request.opened")).toHaveLength(1);
  });

  it("routes AskUserQuestion through a question card and answers it keyed by question text", async () => {
    const dump = newDump();
    await create({ mode: "question" });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "question", text: "Fixture" });
    const opened = (await recorder.until((event) => event.type === "request.opened" && event.requestType === "question")) as Extract<RuntimeEvent, { type: "request.opened" }>;
    expect(opened.summary).toBe("Pick one");
    expect(opened.choices).toEqual(["alpha", "beta"]);
    const outcome = await instance.adapter.respondToRequest("question", opened.requestId!, { behavior: "answer", message: "alpha" });
    expect(outcome).toBe("answered");
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const seen = JSON.parse(readFileSync(dump, "utf8")) as Dump;
    expect(Object.values(seen.answers)).toEqual([{ action: "accept", content: { answers: { "Pick one": "alpha" } } }]);
    expect(seen.v1Replies).toEqual({});
  });

  it("stops a running turn through the session and settles it as interrupted", async () => {
    const dump = newDump();
    await create({ mode: "hold" });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "hold", text: "Fixture" });
    await recorder.until((event) => event.type === "session.started");
    await vi.waitFor(() => expect(commandsOf(JSON.parse(readFileSync(dump, "utf8")), "sendText")).toHaveLength(1));
    await instance.adapter.interruptTurn("hold", turnId);
    const completed = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(completed).toMatchObject({ ok: true, stopReason: "interrupted" });
    expect(commandsOf(JSON.parse(readFileSync(dump, "utf8")), "stop")).toHaveLength(1);
    expect(instance.adapter.hasSession("hold")).toBe(false);
  });

  it("settles a mid-turn crash as a failed turn with the exit attributed", async () => {
    newDump();
    await create({ mode: "exit-mid-turn" });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "crash", text: "Fixture" });
    const completed = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(completed).toMatchObject({ ok: false });
    expect(recorder.events.some((event) => event.type === "runtime.error" && /exited \(code 1\).*synthetic mid-turn crash/.test(event.message))).toBe(true);
  });
  describe("transient provider failures", () => {
    const sendsOf = (dump: string) => commandsOf(JSON.parse(readFileSync(dump, "utf8")), "sendText");
    const notices = () => recorder.events.filter((event) => event.type === "runtime.notice");

    afterEach(() => {
      delete process.env.FAKE_ZCODE_RETRY_SCALE;
    });

    it("resumes the same session after a dropped provider connection and says so in the thread", async () => {
      process.env.FAKE_ZCODE_RETRY_SCALE = "0.01";
      const dump = newDump();
      await create({ mode: "network-flaky" });
      const { turnId } = await instance.adapter.sendTurn({ threadId: "flaky", text: "Fixture" });
      const completed = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
      expect(completed).toMatchObject({ ok: true });
      const sends = sendsOf(dump);
      expect(sends).toHaveLength(2);
      expect(sends[1]!.sessionId).toBe(sends[0]!.sessionId);
      expect(sends[1]!.payload).toEqual({ text: ZCODE_RESUME_PROMPT, mode: "build" });
      expect(notices()).toHaveLength(1);
      expect(notices()[0]).toMatchObject({ message: expect.stringMatching(/network_error.*resume 1 of 5/) });
      expect(recorder.events.some((event) => event.type === "runtime.error")).toBe(false);
      expect(recorder.events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    });

    it("gives up after the resume budget and fails the turn with zcode's error", async () => {
      process.env.FAKE_ZCODE_RETRY_SCALE = "0.001";
      const dump = newDump();
      await create({ mode: "network-always" });
      const { turnId } = await instance.adapter.sendTurn({ threadId: "always", text: "Fixture" });
      const completed = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
      expect(completed).toMatchObject({ ok: false, stopReason: "failed" });
      expect(sendsOf(dump)).toHaveLength(1 + ZCODE_MAX_TURN_RESUMES);
      expect(notices()).toHaveLength(ZCODE_MAX_TURN_RESUMES);
      expect(recorder.events.some((event) => event.type === "runtime.error" && event.message === "model request failed")).toBe(true);
    });

    it("does not resume a request the provider refused", async () => {
      process.env.FAKE_ZCODE_RETRY_SCALE = "0.001";
      const dump = newDump();
      await create({ mode: "refused-401" });
      const { turnId } = await instance.adapter.sendTurn({ threadId: "refused", text: "Fixture" });
      const completed = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
      expect(completed).toMatchObject({ ok: false });
      expect(sendsOf(dump)).toHaveLength(1);
      expect(notices()).toHaveLength(0);
    });

    it("cancels the wait when the turn is stopped", async () => {
      const dump = newDump();
      await create({ mode: "network-flaky" });
      const { turnId } = await instance.adapter.sendTurn({ threadId: "stopped-wait", text: "Fixture" });
      await recorder.until((event) => event.type === "runtime.notice");
      await instance.adapter.interruptTurn("stopped-wait", turnId);
      const completed = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
      expect(completed).toMatchObject({ ok: true, stopReason: "interrupted" });
      expect(sendsOf(dump)).toHaveLength(1);
      expect(recorder.events.some((event) => event.type === "runtime.error")).toBe(false);
    });
  });

  describe.skipIf(process.platform === "win32")("bot home", () => {
    // The real `zcode` launcher is a shell script that runs `$HOME/.zcode/server/...`.
    const launchThroughWrapper = async (sourceHome: string, environment: Record<string, string>, instanceId: string) => {
      writePersonalSetup(sourceHome);
      symlinkSync(FAKE_CLI, join(sourceHome, ".zcode", "server", "fake-zcode.ts"));
      const wrapper = join(scratch, "zcode");
      writeFileSync(wrapper, "#!/bin/sh\nexec \"$HOME/.zcode/server/fake-zcode.ts\" \"$@\"\n", { mode: 0o755 });
      instance = await ZcodeDriver.create({ instanceId, displayName: "ZCode Bot Home", environment, enabled: true, config: { cli: wrapper } });
      recorder = recordEvents(instance.adapter);
    };
    const runTurn = async (input: Partial<Parameters<ProviderInstance["adapter"]["sendTurn"]>[0]> = {}) => {
      const dump = newDump();
      const { turnId } = await instance.adapter.sendTurn({
        threadId: `bot-home-${dumps.length}`,
        text: "Fixture",
        integrations: { custom: { notes: { command: "node", args: ["notes.mjs"], env: { TOKEN: "t" } } } },
        ...input,
      });
      const completed = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
      return { completed, seen: JSON.parse(readFileSync(dump, "utf8")) };
    };

    afterEach(() => {
      rmSync(join(homedir(), ".zcode"), { recursive: true, force: true });
    });

    it("launches the wrapper from a bot home without the person's hooks, MCP servers or instructions", async () => {
      const sourceHome = homedir();
      await launchThroughWrapper(sourceHome, {}, "zcode-bot-home");
      const { completed, seen } = await runTurn();
      expect(completed).toMatchObject({ ok: true });
      const botHome = seen.env.HOME;
      expect(botHome).toBe(join(DATA_DIR, "providers", "zcode", createHash("sha256").update("zcode-bot-home").digest("hex"), "home"));
      expect(existsSync(join(botHome, ".zcode", "cli", "config.json"))).toBe(false);
      expect(existsSync(join(botHome, ".zcode", "AGENTS.md"))).toBe(false);
      expect(seen.env).toMatchObject({
        ZCODE_DATA_BASE_DIR: sourceHome,
        ZCODE_SESSION_DB_PATH: join(sourceHome, ".zcode", "cli", "db", "db.sqlite"),
      });
      const create = commandOf(seen, "createSession");
      expect(create.payload.mcpServers.map((server: { name: string }) => server.name)).toEqual(["notes"]);
      const env = Object.fromEntries(create.payload.mcpServers[0].env.map(({ name, value }: { name: string; value: string }) => [name, value]));
      expect(env.HOME).toBe(sourceHome);
      const gate = JSON.parse(env[`OMB_GATE_CONFIG_${createHash("sha256").update("notes").digest("hex")}`]);
      expect(gate.OMB_GATE_DISCOVERY).toBe("1");
      expect(JSON.parse(gate.OMB_GATE_UPSTREAM)).toEqual({ command: "node", args: ["notes.mjs"], env: { TOKEN: "t" } });
    });

    it("anchors on an explicitly configured HOME and keeps explicit storage across a resumed model turn", async () => {
      const sourceHome = join(scratch, "custom-home");
      await launchThroughWrapper(sourceHome, { HOME: sourceHome, ZCODE_SESSION_DB_PATH: "~/kept/db.sqlite" }, "zcode-custom-home");
      const { completed, seen } = await runTurn({ resumeCursor: "sess_old", model: "zai-fake/glm-5.3-flash$low", approvalMode: "edits" });
      expect(completed).toMatchObject({ ok: true });
      expect(stepsOf(seen)).toEqual(["session/resume", "v4/conversation/subscribe", "switchModelConfig", "sendText"]);
      expect(commandOf(seen, "sendText").payload.mode).toBe("edit");
      expect(commandOf(seen, "switchModelConfig").payload).toEqual({ provider: "zai-fake", model: "glm-5.3-flash", thought: "low" });
      expect(seen.env).toMatchObject({
        ZCODE_DATA_BASE_DIR: sourceHome,
        ZCODE_SESSION_DB_PATH: join(sourceHome, "kept", "db.sqlite"),
      });
      expect(seen.env.HOME).not.toBe(sourceHome);
      expect(seen.calls[0].params.mcpServers[0].env).toContainEqual({ name: "HOME", value: sourceHome });
    });

    it("fails turns and reports unavailable when the bot home cannot be prepared", async () => {
      const instanceId = "zcode-broken-home";
      const directory = join(DATA_DIR, "providers", "zcode", createHash("sha256").update(instanceId).digest("hex"));
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "home"), "not a directory");
      try {
        instance = await ZcodeDriver.create({ instanceId, displayName: "ZCode Broken", environment: {}, enabled: true, config: { cli: FAKE_CLI } });
        await expect(instance.adapter.sendTurn({ threadId: "broken", text: "Fixture" })).rejects.toThrow(/Could not prepare the ZCode bot home/);
        expect(await instance.snapshot()).toMatchObject({ state: "unavailable", reason: expect.stringMatching(/Could not prepare the ZCode bot home/) });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });
});
