import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chooseZcodeConnection, ZcodeServerAuth, zcodeServerAuthStatus } from "./auth.ts";
import type { ZcodeChannelClient } from "./channel.ts";

const INDIVIDUAL = "account:zai-individual-coding-plan";
const START = "account:zai-start-plan";
const URL_OK = "https://chat.z.ai/authorize?state=abc";
const TOKEN = "secret-token-value";

const view = (...entitled: string[]) => ({
  providers: [INDIVIDUAL, START, "deepseek"].map((providerId) => ({
    providerId,
    ...(providerId === "deepseek" ? {} : { accountState: { entitled: entitled.includes(providerId) } }),
  })),
});

describe("chooseZcodeConnection", () => {
  it("prefers Individual, falls back to Start Plan, and does nothing without a plan", () => {
    expect(chooseZcodeConnection(view(INDIVIDUAL, START))).toBe("individual-coding-plan");
    expect(chooseZcodeConnection(view(START))).toBe("start-plan");
    expect(chooseZcodeConnection(view())).toBeNull();
    expect(chooseZcodeConnection(undefined)).toBeNull();
  });
});

describe("zcodeServerAuthStatus", () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "zcode-auth-"));
  });
  afterEach(() => rm(dataDir, { recursive: true, force: true }));

  const store = async (folder: string, content: string) => {
    await mkdir(join(dataDir, folder, "v2"), { recursive: true });
    await writeFile(join(dataDir, folder, "v2", "credentials.json"), content);
  };

  it("reports a stored Z.ai login from either data folder", async () => {
    const login = JSON.stringify({ "oauth:zai:access_token": "encrypted", zcodejwttoken: "encrypted" });
    await store(".zcode", login);
    expect(await zcodeServerAuthStatus(dataDir)).toEqual({ authenticated: true });
    await rm(join(dataDir, ".zcode"), { recursive: true });
    await store(".zcodium", login);
    expect(await zcodeServerAuthStatus(dataDir)).toEqual({ authenticated: true });
  });

  it("reports no login for other keys, a missing file, or unreadable JSON", async () => {
    expect(await zcodeServerAuthStatus(dataDir)).toEqual({ authenticated: false });
    await store(".zcode", JSON.stringify({ "mcp:oauth:x:discovery_state": "x" }));
    expect(await zcodeServerAuthStatus(dataDir)).toEqual({ authenticated: false });
    await store(".zcode", "not json");
    expect(await zcodeServerAuthStatus(dataDir)).toEqual({ authenticated: false });
  });
});

describe("ZcodeServerAuth", () => {
  interface Call {
    channel: string;
    method: string;
    args: readonly unknown[] | undefined;
  }
  function fake(options: { entitled?: string[]; selections?: unknown; approveAfter?: number; fail?: string; startResult?: unknown } = {}) {
    const calls: Call[] = [];
    let polls = 0;
    const client = {
      call: async (channel: string, method: string, args?: readonly unknown[]) => {
        calls.push({ channel, method, args });
        const name = `${channel}.${method}`;
        if (options.fail === name) throw new Error(`remote said ${TOKEN}`);
        switch (name) {
          case "oauth.startOAuthWithPolling":
            return "startResult" in options ? options.startResult : { authorizeUrl: URL_OK };
          case "oauth.pollPendingOAuth":
            polls += 1;
            return polls < (options.approveAfter ?? 2) ? null : { kind: "session" };
          case "provider-settings.getView":
            return view(...(options.entitled ?? []));
          case "setting.get":
            return options.selections === undefined ? {} : { providerFamilyConnectionSelections: options.selections };
          default:
            return {};
        }
      },
    } as unknown as ZcodeChannelClient;
    let refreshes = 0;
    const auth = new ZcodeServerAuth({
      withClient: (use) => use(client),
      refresh: async () => {
        refreshes += 1;
      },
      ttlMs: 60_000,
    });
    return { auth, calls, refreshes: () => refreshes };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("starts a flow with the browser link, an id, and an expiry", async () => {
    const { auth, calls } = fake();
    const started = await auth.start();
    expect(started).toMatchObject({ phase: "waiting", authorizationUrl: URL_OK, expiresAt: "2026-01-01T00:01:00.000Z" });
    expect(started.flowId).toEqual(expect.any(String));
    expect(calls.map((call) => `${call.channel}.${call.method}`)).toEqual(["oauth.startOAuthWithPolling"]);
    expect(calls[0].args).toEqual(["zai"]);
  });

  it("returns the same flow while one is waiting, even for concurrent starts", async () => {
    const { auth, calls } = fake();
    const [a, b] = await Promise.all([auth.start(), auth.start()]);
    const c = await auth.start();
    expect(b.flowId).toBe(a.flowId);
    expect(c.flowId).toBe(a.flowId);
    expect(calls.filter((call) => call.method === "startOAuthWithPolling")).toHaveLength(1);
  });

  it("polls until approved, activates Individual with the compare-and-swap write, then succeeds", async () => {
    const { auth, calls, refreshes } = fake({ entitled: [INDIVIDUAL, START] });
    const { flowId } = await auth.start();
    expect((await auth.status(flowId!)).phase).toBe("waiting");
    expect(calls.some((call) => call.method === "update")).toBe(false);
    const done = await auth.status(flowId!);
    expect(done).toMatchObject({ phase: "succeeded", authorizationUrl: null });
    expect(calls.find((call) => call.method === "update")?.args).toEqual([
      { providerFamilyDomain: "zai", providerFamilyConnectionSelections: { zai: { kind: "individual-coding-plan" } } },
      { providerFamilyConnectionSelections: {}, providerFamilyDomainUpdatedAt: 0 },
    ]);
    expect(calls.find((call) => call.method === "refresh")?.args).toEqual(["signed-in"]);
    expect(refreshes()).toBe(1);
    expect((await auth.status(flowId!)).phase).toBe("succeeded");
    expect(calls.filter((call) => call.method === "pollPendingOAuth")).toHaveLength(2);
  });

  it("keeps other selections in the write and uses the stored timestamp and domain", async () => {
    const calls: Call[] = [];
    const client = {
      call: async (channel: string, method: string, args?: readonly unknown[]) => {
        calls.push({ channel, method, args });
        if (method === "startOAuthWithPolling") return { authorizeUrl: URL_OK };
        if (method === "pollPendingOAuth") return { kind: "session" };
        if (method === "getView") return view(START);
        if (method === "get") return { providerFamilyDomain: "other", providerFamilyDomainUpdatedAt: 7, providerFamilyConnectionSelections: { zai: { kind: "x" }, deepseek: { kind: "k" } } };
        return {};
      },
    } as unknown as ZcodeChannelClient;
    const auth = new ZcodeServerAuth({ withClient: (use) => use(client), refresh: async () => {} });
    const { flowId } = await auth.start();
    expect((await auth.status(flowId!)).phase).toBe("succeeded");
    expect(calls.find((call) => call.method === "update")?.args).toEqual([
      { providerFamilyDomain: "zai", providerFamilyConnectionSelections: { zai: { kind: "start-plan" }, deepseek: { kind: "k" } } },
      { providerFamilyDomain: "other", providerFamilyConnectionSelections: { zai: { kind: "x" }, deepseek: { kind: "k" } }, providerFamilyDomainUpdatedAt: 7 },
    ]);
  });

  it("uses Start Plan alone, and skips the write for a matching choice or an account without a plan", async () => {
    const run = async (options: Parameters<typeof fake>[0]) => {
      const { auth, calls } = fake({ approveAfter: 1, ...options });
      const { flowId } = await auth.start();
      const status = await auth.status(flowId!);
      return { calls, status, update: calls.find((call) => call.method === "update") };
    };
    expect((await run({ entitled: [START] })).update?.args?.[0]).toEqual({ providerFamilyDomain: "zai", providerFamilyConnectionSelections: { zai: { kind: "start-plan" } } });
    expect((await run({ entitled: [INDIVIDUAL], selections: { zai: { kind: "individual-coding-plan" } } })).update).toBeUndefined();
    const noPlan = await run({ entitled: [] });
    expect(noPlan.update).toBeUndefined();
    expect(noPlan.status.phase).toBe("succeeded");
  });

  it("reports expired after ttlMs, cancels the pending server flow, and lets a new start begin fresh", async () => {
    const { auth, calls } = fake();
    const first = await auth.start();
    vi.setSystemTime(new Date("2026-01-01T00:01:00.000Z"));
    const status = await auth.status(first.flowId!);
    expect(status).toMatchObject({ phase: "expired", authorizationUrl: null, message: "Z.ai sign-in expired. Start again." });
    expect(calls.map((call) => call.method)).toEqual(["startOAuthWithPolling", "cancelPending"]);
    const second = await auth.start();
    expect(second.flowId).not.toBe(first.flowId);
    expect(second.phase).toBe("waiting");
  });

  it("restarts a waiting flow that expired without a status read", async () => {
    const { auth, calls } = fake();
    const first = await auth.start();
    vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));
    const second = await auth.start();
    expect(second.flowId).not.toBe(first.flowId);
    expect(calls.map((call) => call.method)).toEqual(["startOAuthWithPolling", "cancelPending", "startOAuthWithPolling"]);
  });

  it("cancels the pending server flow and reports cancelled", async () => {
    const { auth, calls } = fake();
    const { flowId } = await auth.start();
    await auth.cancel();
    expect(calls.at(-1)).toEqual({ channel: "oauth", method: "cancelPending", args: ["zai"] });
    expect(await auth.status(flowId!)).toMatchObject({ phase: "cancelled", authorizationUrl: null, message: "Z.ai sign-in was cancelled." });
    const callCount = calls.length;
    await auth.cancel();
    expect(calls).toHaveLength(callCount);
  });

  it("fails with fixed text when the server errors, never echoing remote text", async () => {
    const { auth } = fake({ fail: "oauth.pollPendingOAuth" });
    const { flowId } = await auth.start();
    const status = await auth.status(flowId!);
    expect(status).toMatchObject({ phase: "failed", message: "Z.ai sign-in failed. Start again." });
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    const unknown = await auth.status("nope");
    expect(unknown.phase).toBe("failed");
  });

  it("rejects a start with no usable link using a fixed message", async () => {
    for (const startResult of [{}, { authorizeUrl: "http://insecure.example/x" }, { authorizeUrl: "javascript:alert(1)" }, undefined]) {
      await expect(fake({ startResult }).auth.start()).rejects.toThrow("Z.ai sign-in could not start. Try again.");
    }
    const failing = fake({ fail: "oauth.startOAuthWithPolling" });
    const error = await failing.auth.start().catch((e: Error) => e);
    expect((error as Error).message).toBe("Z.ai sign-in could not start. Try again.");
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it("signs out through the server, refreshes the catalog, and hides the old flow", async () => {
    const { auth, calls, refreshes } = fake();
    const { flowId } = await auth.start();
    await auth.signOut();
    expect(calls.map((call) => `${call.method}:${JSON.stringify(call.args)}`)).toEqual([
      'startOAuthWithPolling:["zai"]',
      'cancelPending:["zai"]',
      'logout:["zai"]',
    ]);
    expect(refreshes()).toBe(1);
    expect((await auth.status(flowId!)).phase).toBe("failed");
  });

  it("reports a fixed sign-out failure without remote text", async () => {
    const { auth, refreshes } = fake({ fail: "oauth.logout" });
    const error = await auth.signOut().catch((e: Error) => e);
    expect((error as Error).message).toBe("Could not sign out of Z.ai. Try again.");
    expect(refreshes()).toBe(0);
  });
});
