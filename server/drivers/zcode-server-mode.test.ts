// ZCode driver in server mode, against the scripted fake ZCode server in
// server/testing/fake-zcode-server.ts. The real process path runs: the host
// starts the fake through a bundle folder's bin/zcode, reads its token and talks
// to it over the channel protocol.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProviderInstance, RuntimeEvent } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { ZcodeDriver } from "./zcode.ts";
import { ZCODE_MAX_TURN_RESUMES, ZCODE_RESUME_PROMPT } from "./zcode-turn-recovery.ts";

const FAKE_SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-zcode-server.ts");
const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-zcode-app-server.ts");

interface Call { channel: string; method: string; args: any[] }

describe("ZcodeDriver in server mode (fake ZCode server)", () => {
  let scratch: string;
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let dumpCount = 0;
  let dumpPath = "";

  /** A bundle folder the host detects as a ZCode server and whose `serve` runs the fake. */
  const makeBundle = () => {
    const root = join(scratch, "bundle");
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "manifest.json"), JSON.stringify({ product: "zcode-server", appVersion: "3.16.2", target: "fake" }));
    writeFileSync(join(root, "bin", "zcode"), `#!/bin/sh\nexec "${process.execPath}" --experimental-strip-types "${FAKE_SERVER}" "$@"\n`, { mode: 0o755 });
    chmodSync(join(root, "bin", "zcode"), 0o755);
    return root;
  };

  const create = async (opts: { mode?: string; config?: Record<string, unknown>; instanceId?: string } = {}) => {
    process.env.FAKE_ZCODE_SERVER_MODE = opts.mode ?? "happy";
    dumpPath = join(scratch, `server-dump-${dumpCount++}.json`);
    process.env.FAKE_ZCODE_SERVER_DUMP = dumpPath;
    instance = await ZcodeDriver.create({
      instanceId: opts.instanceId ?? "zcode-server-test",
      displayName: "ZCode Server Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, server: true, ...opts.config },
    });
    recorder = recordEvents(instance.adapter);
  };
  const calls = (): Call[] => (JSON.parse(readFileSync(dumpPath, "utf8")).calls as Call[]);
  const called = (method: string) => calls().filter((call) => call.method === method);
  const completed = (turnId: string) => recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "omb-zcode-server-test-"));
    process.env.OMB_ZCODE_SERVER_PATH = makeBundle();
    process.env.FAKE_ZCODE_RETRY_SCALE = "0.01";
  });

  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    delete process.env.OMB_ZCODE_SERVER_PATH;
    delete process.env.FAKE_ZCODE_SERVER_MODE;
    delete process.env.FAKE_ZCODE_SERVER_DUMP;
    delete process.env.FAKE_ZCODE_RETRY_SCALE;
    removeTempDir(scratch);
  });

  it("keeps a plain instance on the CLI path and decodes the server switch", () => {
    expect(ZcodeDriver.decodeConfig({ cli: "zcode" })).toEqual({ cli: "zcode" });
    expect(ZcodeDriver.decodeConfig({ server: true })).toEqual({ cli: "zcode", server: true });
    expect(ZcodeDriver.decodeConfig({ server: "on" })).toEqual({ cli: "zcode", server: true });
    expect(ZcodeDriver.decodeConfig({ server: "maybe" })).toEqual({ cli: "zcode" });
  });

  it("runs a turn on the server in the instance's bot home identity and normalizes its events", async () => {
    await create();
    const cwd = scratch;
    const { turnId } = await instance.adapter.sendTurn({ threadId: "happy", text: "Fixture", cwd, system: "You are a fixture bot.", model: "account:zai-start-plan/GLM-5.3-Flash$high" });
    const done = await completed(turnId);
    expect(done).toMatchObject({ ok: true, usage: { input: 100, output: 7, cachedInput: 40 } });

    const identity = createHash("sha256").update("zcode-server-test").digest("hex");
    expect(called("saveProject")[0]!.args).toEqual([{ roots: [cwd] }]);
    const created = called("createSession")[0]!.args[0];
    expect(created).toMatchObject({ workspacePath: cwd, workspaceIdentity: identity, projectId: "project-1", mode: "build" });
    expect(created.workspace).toBeUndefined();
    expect(called("setModel")[0]!.args[0]).toMatchObject({ sessionId: "session_fake_1", model: { providerId: "account:zai-start-plan", modelId: "GLM-5.3-Flash", options: { reasoningLevel: "high" } } });
    expect(called("sendPrompt")[0]!.args[0].content).toContain("You are a fixture bot.");
    expect(recorder.events).toContainEqual(expect.objectContaining({ type: "session.started", sessionId: "session_fake_1" }));
    const text = recorder.events.filter((event) => event.type === "content.delta" && event.streamKind === "assistant_text").map((event) => (event as { delta: string }).delta).join("");
    expect(text).toBe("Hello");
    expect(recorder.events).toContainEqual(expect.objectContaining({ type: "item.completed", itemType: "tool", itemId: "call_1", ok: true }));
  });

  it("resumes the server session from its cursor and ignores a CLI cursor on a new server turn", async () => {
    await create();
    const resumed = await instance.adapter.sendTurn({ threadId: "resume", text: "Continue", cwd: scratch, resumeCursor: "session_fake_9" });
    await completed(resumed.turnId);
    expect(called("resumeSession")[0]!.args[0]).toMatchObject({ sessionId: "session_fake_9" });
    expect(called("createSession")).toHaveLength(0);
    // The persona is not resent on a resumed session.
    expect(called("sendPrompt")[0]!.args[0].content).toBe("Continue");
  });

  it("keeps a CLI conversation on the CLI even when server mode is on", async () => {
    process.env.FAKE_ZCODE_MODE = "happy";
    process.env.FAKE_ZCODE_DUMP = join(scratch, "cli-dump.json");
    try {
      await create();
      const { turnId } = await instance.adapter.sendTurn({ threadId: "cli-thread", text: "Continue", cwd: scratch, resumeCursor: "sess_old" });
      await completed(turnId);
      const seen = JSON.parse(readFileSync(process.env.FAKE_ZCODE_DUMP!, "utf8"));
      expect(seen.calls.map((call: { method: string }) => call.method)).toEqual(["session/resume", "session/setMode", "session/subscribe", "session/send"]);
      expect(seen.calls[0].params.sessionId).toBe("sess_old");
    } finally {
      delete process.env.FAKE_ZCODE_MODE;
      delete process.env.FAKE_ZCODE_DUMP;
    }
  });

  it("lists the server's models with their effort levels as variants and turns an explicit level into the selection", async () => {
    await create();
    await instance.refreshModels?.();
    expect(instance.models.options.map((option) => option.id)).toEqual(["account:zai-start-plan/GLM-5.3-Flash$high", "account:zai-individual-coding-plan/GLM-5.3$high"]);
    expect(instance.models.options[0]!.variants?.map((variant) => variant.id)).toEqual(["low", "high", "max"]);
    expect(instance.adapter.capabilities).toMatchObject({ modelVariants: true, queueing: true });

    const { turnId } = await instance.adapter.sendTurn({ threadId: "variant", text: "Fixture", cwd: scratch, model: "account:zai-start-plan/GLM-5.3-Flash$high", variant: "max" });
    await completed(turnId);
    expect(called("setModel")[0]!.args[0].model.options).toEqual({ reasoningLevel: "max" });
  });

  it("fails an effort level the model does not offer, and a bad model id, before starting a turn", async () => {
    await create();
    await instance.refreshModels?.();
    await expect(instance.adapter.sendTurn({ threadId: "bad-variant", text: "x", cwd: scratch, model: "account:zai-individual-coding-plan/GLM-5.3$high", variant: "max" }))
      .rejects.toThrow(/not an effort level of GLM-5\.3/);
    await expect(instance.adapter.sendTurn({ threadId: "bad-model", text: "x", cwd: scratch, model: "GLM-5.3-Flash$max" }))
      .rejects.toThrow(/not a zcode model selection/);
  });

  it("answers a permission ask through resolveInteraction with the option the driver chose", async () => {
    await create({ mode: "approval" });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "ask", text: "Fixture", cwd: scratch, approvalMode: "ask" });
    const opened = (await recorder.until((event) => event.type === "request.opened")) as Extract<RuntimeEvent, { type: "request.opened" }>;
    expect(opened).toMatchObject({ requestType: "permission", tool: "Bash", command: { command: "ls", cwd: "/tmp" } });
    expect(await instance.adapter.respondToRequest("ask", opened.requestId!, { behavior: "allow" })).toBe("allowed-once");
    await completed(turnId);
    const command = called("sendConversationCommandV4").map((call) => call.args[0].envelope).find((envelope) => envelope.type === "resolveInteraction");
    expect(command.payload).toEqual({ interactionId: "perm-1", answer: { optionId: "allow-1" } });
    expect(called("helloConversationV4")).toHaveLength(1);
  });

  it("echoes the server's own allow option under Full access without opening a card", async () => {
    await create({ mode: "approval" });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "full", text: "Fixture", cwd: scratch, approvalMode: "full" });
    await completed(turnId);
    expect(recorder.events.some((event) => event.type === "request.opened")).toBe(false);
    const command = called("sendConversationCommandV4").map((call) => call.args[0].envelope).find((envelope) => envelope.type === "resolveInteraction");
    expect(command.payload.answer).toEqual({ optionId: "allow-1" });
  });

  it("stops a running turn with a v4 stop and settles it as interrupted", async () => {
    await create({ mode: "hold" });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "stop", text: "Fixture", cwd: scratch });
    await recorder.until((event) => event.type === "content.delta");
    await instance.adapter.interruptTurn("stop", turnId);
    const done = await completed(turnId);
    expect(done).toMatchObject({ ok: true, stopReason: "interrupted" });
    expect(called("sendConversationCommandV4").map((call) => call.args[0].envelope.type)).toContain("stop");
  });

  it("steers a running turn with guided input, and refuses once the turn is over or with images", async () => {
    await create({ mode: "hold" });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "steer", text: "Fixture", cwd: scratch });
    await recorder.until((event) => event.type === "content.delta");
    expect(await instance.adapter.steer!("steer", "use tabs", [{ path: "/x.png", mime: "image/png", bytes: 1 }])).toBe("refused");
    expect(await instance.adapter.steer!("steer", "use tabs")).toBe("steered");
    const envelope = called("sendConversationCommandV4").map((call) => call.args[0].envelope).find((e) => e.type === "sendText");
    expect(envelope.payload).toEqual({ text: "use tabs", requestedDelivery: "guide" });
    await completed(turnId);
    expect(await instance.adapter.steer!("steer", "too late")).toBe("refused");
    expect(await instance.adapter.steer!("nobody", "hi")).toBe("refused");
  });

  it("resumes the server session after a dropped provider connection", async () => {
    await create({ mode: "network-flaky" });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "flaky", text: "Fixture", cwd: scratch });
    expect(await completed(turnId)).toMatchObject({ ok: true });
    const sends = called("sendPrompt");
    expect(sends).toHaveLength(2);
    expect(sends[1]!.args[0]).toMatchObject({ sessionId: sends[0]!.args[0].sessionId, content: ZCODE_RESUME_PROMPT });
    expect(recorder.events.filter((event) => event.type === "runtime.notice")).toHaveLength(1);
  });

  it("gives up on a connection that never recovers after the resume budget", async () => {
    await create({ mode: "network-always" });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "never", text: "Fixture", cwd: scratch });
    expect(await completed(turnId)).toMatchObject({ ok: false, stopReason: "failed" });
    expect(called("sendPrompt")).toHaveLength(1 + ZCODE_MAX_TURN_RESUMES);
  });

  it("runs a new conversation through the CLI when the server cannot be started, and fails a server one", async () => {
    process.env.OMB_ZCODE_SERVER_PATH = join(scratch, "nowhere");
    process.env.FAKE_ZCODE_MODE = "happy";
    process.env.FAKE_ZCODE_DUMP = join(scratch, "cli-dump.json");
    try {
      await create();
      const fresh = await instance.adapter.sendTurn({ threadId: "fallback", text: "Fixture", cwd: scratch });
      expect(await completed(fresh.turnId)).toMatchObject({ ok: true });
      expect(recorder.events).toContainEqual(expect.objectContaining({ type: "runtime.notice", message: expect.stringContaining("ZCode server unavailable") }));
      const seen = JSON.parse(readFileSync(process.env.FAKE_ZCODE_DUMP!, "utf8"));
      expect(seen.calls[0].method).toBe("session/create");

      const resumed = await instance.adapter.sendTurn({ threadId: "gone", text: "Continue", cwd: scratch, resumeCursor: "session_fake_1" });
      expect(await completed(resumed.turnId)).toMatchObject({ ok: false, stopReason: "setup_failed" });
      expect(recorder.events.some((event) => event.type === "runtime.error" && /not installed/.test(event.message))).toBe(true);
    } finally {
      delete process.env.FAKE_ZCODE_MODE;
      delete process.env.FAKE_ZCODE_DUMP;
    }
  });

  it("signs in to Z.ai through the server and reports the account as signed in", async () => {
    process.env.FAKE_ZCODE_SERVER_POLLS = "1";
    try {
      await create();
      expect(instance.authenticationMethod).toBe("browser-poll");
      const started = await instance.startAuthentication!();
      expect(started).toMatchObject({ phase: "waiting", authorizationUrl: expect.stringMatching(/^https:\/\/chat\.z\.ai\//) });
      let status = await instance.getAuthentication!(started.flowId!);
      for (let i = 0; i < 5 && status.phase === "waiting"; i++) status = await instance.getAuthentication!(started.flowId!);
      expect(status.phase).toBe("succeeded");
      expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true });
      await instance.signOut!();
      expect(called("logout")).toHaveLength(1);
    } finally {
      delete process.env.FAKE_ZCODE_SERVER_POLLS;
    }
  });
});
