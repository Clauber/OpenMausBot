// Real ZCode server, no real model. Opt-in: set OMB_ZCODE_SERVER_E2E_ROOT to an official server folder
// (it holds bin/zcode and manifest.json), for example
//
//   OMB_ZCODE_SERVER_E2E_ROOT=/path/to/zcode-server-linux-x64 pnpm exec vitest run server/zcode-server.e2e.test.ts
//
// Everything is disposable: the suite's throwaway HOME stands in for the person's home, the server runs on a
// loopback port with a data folder inside it, and the model is a loopback Anthropic-compatible stand-in
// (server/testing/fake-anthropic-provider.ts). No account, key or real model is touched. See
// docs/verification/zcode-server.md for what this does and does not prove.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ProviderInstance, RuntimeEvent } from "./contracts.ts";
import { ZcodeDriver } from "./drivers/zcode.ts";
import { startFakeAnthropicProvider, type FakeAnthropicProvider } from "./testing/fake-anthropic-provider.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "./testing/events.ts";

const ROOT = process.env.OMB_ZCODE_SERVER_E2E_ROOT;
// The model list gives this model the level "enabled"; a bare id takes it.
const MODEL = "fake/fake-model";

interface Bot { instance: ProviderInstance; recorder: EventRecorder; home: string; cwd: string; stamps: Array<{ at: number; event: RuntimeEvent }> }

const identityOf = (instanceId: string) => createHash("sha256").update(instanceId).digest("hex");
const botHomeOf = (instanceId: string) => join(DATA_DIR, "providers", "zcode", identityOf(instanceId), "home");
const write = (path: string, content: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
};

/** A bot home with its own instructions, a skill and a hook that records that it ran. */
function prepareHome(home: string, name: string) {
  write(join(home, ".zcode", "AGENTS.md"), `Instruction marker ${name}-AGENTS.\n`);
  write(join(home, ".zcode", "skills", `${name.toLowerCase()}-skill`, "SKILL.md"), `---\nname: ${name.toLowerCase()}-skill\ndescription: Skill marker ${name}-SKILL.\n---\nUse only for ${name}.\n`);
  write(join(home, ".zcode", "cli", "config.json"), JSON.stringify({
    hooks: { enabled: true, events: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `echo ${name}-HOOK > "$HOME/hook-ran"`, timeout: 10, enabled: true }] }] } },
  }));
}

describe.skipIf(ROOT === undefined)("ZCode server mode against the real server (fake model)", () => {
  let provider: FakeAnthropicProvider;
  let flaky: FakeAnthropicProvider;
  let flakyForCli: FakeAnthropicProvider;
  let scratch: string;
  const bots = new Map<string, Bot>();

  const bot = async (name: string): Promise<Bot> => {
    const existing = bots.get(name);
    if (existing) return existing;
    const home = botHomeOf(name);
    prepareHome(home, name.toUpperCase());
    const cwd = join(scratch, `work-${name}`);
    mkdirSync(cwd, { recursive: true });
    const instance = await ZcodeDriver.create({ instanceId: name, displayName: name, environment: {}, enabled: true, config: { cli: "zcode-not-used", server: true } });
    // The list names each model's effort level; a turn on a bare provider/model id needs it.
    await instance.refreshModels?.();
    const recorder = recordEvents(instance.adapter);
    const stamps: Bot["stamps"] = [];
    instance.adapter.onEvent((event) => stamps.push({ at: Date.now(), event }));
    const made = { instance, recorder, home, cwd, stamps };
    bots.set(name, made);
    return made;
  };
  const turn = async (b: Bot, threadId: string, text: string, extra: Partial<Parameters<ProviderInstance["adapter"]["sendTurn"]>[0]> = {}) => {
    const { turnId } = await b.instance.adapter.sendTurn({ threadId, text, cwd: b.cwd, model: MODEL, ...extra });
    const done = async () => {
      const completed = await b.recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId, 120_000);
      const errors = b.recorder.events.filter((event) => event.type === "runtime.error").map((event) => (event as { message: string }).message);
      if (errors.length) console.error(`turn ${threadId} errors:`, errors);
      return completed;
    };
    return { turnId, done };
  };

  beforeAll(async () => {
    process.env.OMB_ZCODE_SERVER_PATH = ROOT;
    scratch = mkdtempSync(join(tmpdir(), "omb-zcode-e2e-"));
    provider = await startFakeAnthropicProvider({ textDelayMs: 500 });
    // zcode retries a dropped stream 10 times itself; this endpoint drops the 11th too, so zcode fails the turn.
    flaky = await startFakeAnthropicProvider({ drops: 11, textDelayMs: 20 });
    flakyForCli = await startFakeAnthropicProvider({ drops: 11, textDelayMs: 20 });
    // The person's own home: instructions and a hook the bots must never see, and the model provider they all share.
    write(join(homedir(), ".zcode", "AGENTS.md"), "Instruction marker CLAUBER-AGENTS.\n");
    write(join(homedir(), ".zcode", "cli", "config.json"), JSON.stringify({
      hooks: { enabled: true, events: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `echo CLAUBER-HOOK > "${join(homedir(), "clauber-hook-ran")}"`, timeout: 10, enabled: true }] }] } },
    }));
    const endpoint = (providerId: string, port: number) => ({ providerId, providerName: providerId, config: {
      group: "standard-personal",
      access: { type: "api-key", apiKey: "test-key" },
      api: { type: "anthropic-messages", baseUrl: `http://127.0.0.1:${port}` },
      personalModelIds: ["fake-model"],
      modelOrder: ["fake-model"],
    } });
    write(join(homedir(), ".zcode", "v2", "provider_config.json"), JSON.stringify({
      schemaVersion: 1,
      config: {
        providerOrder: ["fake", "flaky", "flaky-cli"],
        providerConfigRules: { providerRules: [endpoint("fake", provider.port), endpoint("flaky", flaky.port), endpoint("flaky-cli", flakyForCli.port)] },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      },
    }));
  }, 60_000);

  afterAll(async () => {
    for (const { instance, recorder } of bots.values()) {
      recorder.stop();
      await instance.dispose();
    }
    await provider?.close();
    await flaky?.close();
    await flakyForCli?.close();
    delete process.env.OMB_ZCODE_SERVER_PATH;
    if (scratch) await removeTempDir(scratch);
  }, 60_000);

  it("lists the server's models and runs a turn with the assistant's text arriving before the turn ends", async () => {
    const a = await bot("bot-a");
    expect(a.instance.models.options.some((option) => option.id.startsWith("fake/fake-model"))).toBe(true);

    const { done } = await turn(a, "text", "say ok");
    const completed = await done();
    const completedAt = a.stamps.find((stamp) => stamp.event === completed)!.at;
    expect(completed).toMatchObject({ ok: true });
    const deltas = a.stamps.filter((stamp) => stamp.event.type === "content.delta" && stamp.event.streamKind === "assistant_text");
    expect(deltas.map((stamp) => (stamp.event as { delta: string }).delta).join("")).toBe("ok. all good");
    // The text reached Legion while the stand-in was still streaming, long before the turn completed.
    const providerFinished = [...provider.finishedAt.values()].at(-1)!;
    expect(deltas[0]!.at).toBeLessThan(providerFinished - 1000);
    expect(deltas[0]!.at).toBeLessThan(completedAt - 1000);
    expect(deltas.length).toBeGreaterThan(3);
  }, 120_000);

  it("seals the assistant's interim text as soon as it ends, before the tool and the final answer", async () => {
    const a = await bot("bot-a");
    a.recorder.events.length = 0;
    const { done } = await turn(a, "narrate", "narrate");
    const completed = await done();
    expect(completed).toMatchObject({ ok: true });
    const events = a.recorder.events;
    const sealed = events.flatMap((event, index) => event.type === "item.completed" && event.itemType === "assistant_text" ? [{ index, text: event.text }] : []);
    expect(sealed.map((item) => item.text)).toEqual(["Checking the files first.", "All done."]);
    const at = (predicate: (event: RuntimeEvent) => boolean) => events.findIndex(predicate);
    // The interim sentence is sealed before the command it announced finishes, and well before the turn does.
    expect(sealed[0]!.index).toBeLessThan(at((event) => event.type === "item.completed" && event.itemType === "tool"));
    expect(sealed[1]!.index).toBeLessThan(at((event) => event.type === "turn.completed"));
  }, 180_000);

  it("gives each bot its own instructions, skills and hooks, never the person's or another bot's, with two bots at once", async () => {
    const a = await bot("bot-a");
    const b = await bot("bot-b");
    const before = provider.requests.length;
    const [ta, tb] = await Promise.all([turn(a, "iso-a", "say ok"), turn(b, "iso-b", "say ok")]);
    await Promise.all([ta.done(), tb.done()]);
    const requests = provider.requests.slice(before);
    const seenBy = (marker: string) => requests.filter((request) => request.system.includes(marker) || request.userText.includes(marker));
    // A request carries its own bot's markers and none of anyone else's.
    for (const [own, other] of [["BOT-A", "BOT-B"], ["BOT-B", "BOT-A"]] as const) {
      const mine = seenBy(`${own}-AGENTS`);
      expect(mine.length, `${own} instructions reach the model`).toBeGreaterThan(0);
      for (const request of mine) {
        const text = request.system + request.userText;
        expect(text).not.toContain(`${other}-AGENTS`);
        expect(text).not.toContain(`${other.toLowerCase()}-skill`);
        expect(text).not.toContain("CLAUBER-AGENTS");
      }
      expect(mine.some((request) => (request.system + request.userText).includes(`${own.toLowerCase()}-skill`))).toBe(true);
    }
    expect(seenBy("CLAUBER-AGENTS")).toHaveLength(0);
    // Hooks ran in the bot's own home only.
    expect(readFileSync(join(a.home, "hook-ran"), "utf8").trim()).toBe("BOT-A-HOOK");
    expect(readFileSync(join(b.home, "hook-ran"), "utf8").trim()).toBe("BOT-B-HOOK");
    expect(existsSync(join(homedir(), "clauber-hook-ran"))).toBe(false);
  }, 180_000);

  it("asks before a write, runs it once allowed, and finishes the turn", async () => {
    const a = await bot("bot-a");
    a.recorder.events.length = 0;
    const { done } = await turn(a, "ask", "write file", { approvalMode: "ask" });
    const opened = (await a.recorder.until((event) => event.type === "request.opened", 120_000)) as Extract<RuntimeEvent, { type: "request.opened" }>;
    expect(opened).toMatchObject({ requestType: "permission", tool: "Write" });
    expect(await a.instance.adapter.respondToRequest("ask", opened.requestId!, { behavior: "allow" })).toBe("allowed-once");
    expect(await done()).toMatchObject({ ok: true });
    expect(existsSync(join(a.cwd, "fixture-note.txt"))).toBe(true);
  }, 180_000);

  it("denies a write the person refused", async () => {
    const a = await bot("bot-a");
    a.recorder.events.length = 0;
    mkdirSync(join(scratch, "denied"), { recursive: true });
    const { done } = await turn(a, "deny", "write file", { approvalMode: "ask", cwd: join(scratch, "denied") });
    const opened = (await a.recorder.until((event) => event.type === "request.opened", 120_000)) as Extract<RuntimeEvent, { type: "request.opened" }>;
    expect(await a.instance.adapter.respondToRequest("deny", opened.requestId!, { behavior: "deny" })).toBe("rejected");
    await done();
    expect(existsSync(join(scratch, "denied", "fixture-note.txt"))).toBe(false);
  }, 180_000);

  it("stops a running turn and settles it as interrupted", async () => {
    const a = await bot("bot-a");
    a.recorder.events.length = 0;
    const { turnId, done } = await turn(a, "stop", "hold on");
    await a.recorder.until((event) => event.type === "content.delta", 120_000);
    await a.instance.adapter.interruptTurn("stop", turnId);
    expect(await done()).toMatchObject({ stopReason: "interrupted" });
  }, 180_000);

  it("steers a running turn: the guidance reaches the model in the same turn", async () => {
    const a = await bot("bot-a");
    a.recorder.events.length = 0;
    const { done } = await turn(a, "steer", "run sleep", { approvalMode: "full" });
    await a.recorder.until((event) => event.type === "item.started" && event.itemType === "tool", 120_000);
    expect(await a.instance.adapter.steer!("steer", "STEER-MARKER prefer tabs")).toBe("steered");
    const completed = await done();
    expect(completed).toMatchObject({ ok: true });
    const answer = a.recorder.events.filter((event) => event.type === "item.completed" && event.itemType === "assistant_text").map((event) => (event as { text: string }).text).join("");
    expect(answer).toContain("saw steer");
    expect(a.recorder.events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
  }, 180_000);

  // The CLI path needs a real zcode CLI install: OMB_ZCODE_CLI_E2E_CLI is its launcher and OMB_ZCODE_CLI_E2E_SERVER_ROOT
  // the folder that launcher expects at $HOME/.zcode/server (for the person's install, ~/.zcode/server).
  it.skipIf(!process.env.OMB_ZCODE_CLI_E2E_CLI || !process.env.OMB_ZCODE_CLI_E2E_SERVER_ROOT)("resumes after dropped streams on the CLI path too, through the real zcode app-server", async () => {
    mkdirSync(join(homedir(), ".zcode"), { recursive: true });
    if (!existsSync(join(homedir(), ".zcode", "server"))) symlinkSync(process.env.OMB_ZCODE_CLI_E2E_SERVER_ROOT!, join(homedir(), ".zcode", "server"));
    const instance = await ZcodeDriver.create({ instanceId: "cli-bot", displayName: "cli-bot", environment: {}, enabled: true, config: { cli: process.env.OMB_ZCODE_CLI_E2E_CLI! } });
    const recorder = recordEvents(instance.adapter);
    process.env.FAKE_ZCODE_RETRY_SCALE = "0.01";
    try {
      const cwd = join(scratch, "work-cli");
      mkdirSync(cwd, { recursive: true });
      const { turnId } = await instance.adapter.sendTurn({ threadId: "cli", text: "say ok", cwd, model: "flaky-cli/fake-model$enabled" });
      const finished = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId, 180_000);
      expect(finished, JSON.stringify(recorder.events.filter((event) => event.type === "runtime.error"))).toMatchObject({ ok: true });
      expect(recorder.events.some((event) => event.type === "runtime.notice" && /Resuming/.test(event.message))).toBe(true);
      expect(flakyForCli.requests.length).toBeGreaterThanOrEqual(12);
    } finally {
      delete process.env.FAKE_ZCODE_RETRY_SCALE;
      recorder.stop();
      await instance.dispose();
    }
  }, 240_000);

  it("resumes the same session after the provider keeps dropping the stream", async () => {
    const c = await bot("bot-c");
    process.env.FAKE_ZCODE_RETRY_SCALE = "0.01";
    try {
      const { done } = await turn(c, "flaky", "say ok", { model: "flaky/fake-model" });
      expect(await done()).toMatchObject({ ok: true });
      expect(c.recorder.events.some((event) => event.type === "runtime.notice" && /Resuming/.test(event.message))).toBe(true);
      expect(flaky.requests.length).toBeGreaterThanOrEqual(12);
    } finally {
      delete process.env.FAKE_ZCODE_RETRY_SCALE;
    }
  }, 240_000);
});
