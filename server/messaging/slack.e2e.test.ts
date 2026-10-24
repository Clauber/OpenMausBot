// The Slack adapter through a real isolated runtime: the actual harness,
// guarded-send path and admin API, with the fake CLI engine as the only
// provider and server/testing/fake-slack.ts standing in for Slack (Web API +
// Socket Mode link). Nothing here could touch a real workspace: the fixture
// only forwards SLACK_API_BASE when it is a loopback URL.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "../../scripts/control-omb.ts";
import { FAKE_APP_TOKEN, FAKE_BOT_TOKEN, startFakeSlack, type FakeSlack } from "../testing/fake-slack.ts";

describe("Slack adapter through an isolated runtime", () => {
  let fixture: VerificationServer;
  let fake: FakeSlack;
  let scratch: string;
  let evidence: unknown[];

  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = { status: response.status, body: await response.json() as any };
    evidence.push({ method, path, body: path.includes("/messaging/") && method === "POST" ? "(redacted)" : body, result });
    return result;
  };
  const socketState = async (bindingId: string) => (await api("GET", `/api/messaging/slack/${bindingId}`)).body.binding.socket as { status: string; error?: string } | null;
  const waitSocket = async (bindingId: string, want: string, rounds = 100) => {
    for (let i = 0; i < rounds; i += 1) {
      const state = await socketState(bindingId);
      if (state?.status === want) return state;
      await new Promise((r) => setTimeout(r, 50));
    }
    return socketState(bindingId);
  };

  beforeEach(async () => {
    evidence = [];
    fake = await startFakeSlack();
    scratch = mkdtempSync(join(tmpdir(), "omb-slack-e2e-"));
    const state = join(scratch, "reply-state");
    writeFileSync(state, "");
    fixture = await launchVerificationServer({
      ...process.env,
      SLACK_API_BASE: fake.url,
      FAKE_CLAUDE_REPLIES: JSON.stringify(["Four."]),
      FAKE_CLAUDE_REPLY_STATE: state,
    });
  }, 30_000);

  afterEach(async () => {
    if (fixture) {
      const evidencePath = `${fixture.info.logPath}.slack.json`;
      writeFileSync(evidencePath, JSON.stringify({ fixture: fixture.info, evidence, fakeSent: fake?.sent, limitation: "Actual runtime and guarded path with the fake engine and a fake Slack (Web API + Socket Mode) only. No live accounts or user data." }, null, 2));
      console.info(JSON.stringify({ logPath: fixture.info.logPath, evidencePath }));
      await fixture.close();
    }
    await fake?.stop();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("binds through Socket Mode, pairs a DM by code, relays the turn, and never echoes tokens", async () => {
    const control = async (args: string[]) => (await runControlOmb([...args, "--url", fixture.info.url])) as any;
    const { bot } = await control(["new-bot", "--name", "Slack fixture"]);

    // refusal paths: bad bot token, bad app token, unknown bot
    const badBot = await api("POST", "/api/messaging/slack", { botId: bot.id, appToken: FAKE_APP_TOKEN, botToken: "xoxb-wrong-token-aaaaaaaaaaaaa" });
    expect(badBot.status).toBe(400);
    expect(badBot.body.error).toMatch(/invalid_auth/);
    expect(badBot.body.error).not.toContain(FAKE_BOT_TOKEN);
    expect(badBot.body.error).not.toContain(FAKE_APP_TOKEN);
    const badApp = await api("POST", "/api/messaging/slack", { botId: bot.id, appToken: "xapp-1-wrong-app-token-bbbbbbbbbbb", botToken: FAKE_BOT_TOKEN });
    expect(badApp.status).toBe(400);
    expect(badApp.body.error).toMatch(/not_allowed_token_type/);
    expect(badApp.body.error).not.toContain(FAKE_BOT_TOKEN);
    expect((await api("POST", "/api/messaging/slack", { botId: "missing", appToken: FAKE_APP_TOKEN, botToken: FAKE_BOT_TOKEN })).status).toBe(404);

    // the real binding: auth.test verifies the bot token, a throwaway
    // apps.connections.open verifies Socket Mode, then the service connects
    expect((await api("POST", "/api/messaging/slack", { botId: bot.id, appToken: FAKE_APP_TOKEN, botToken: FAKE_BOT_TOKEN })).status).toBe(201);
    const binding = (await api("GET", "/api/messaging/slack")).body.bindings.at(-1);
    expect(binding).toMatchObject({ botId: bot.id, teamName: "Fake Workspace", botUserId: "U0FAKEBOTUSER" });
    expect(JSON.stringify(await api("GET", "/api/messaging/slack").then((r) => r.body))).not.toContain(FAKE_BOT_TOKEN);
    expect(JSON.stringify(await api("GET", "/api/messaging/slack").then((r) => r.body))).not.toContain(FAKE_APP_TOKEN);
    expect(await waitSocket(binding.id, "connected")).toMatchObject({ status: "connected" });

    // pairing: the code comes from the admin API and is spent by a DM
    const pairing = await api("POST", `/api/messaging/slack/${binding.id}/pairing`, {});
    expect(pairing.body.code).toMatch(/^\d{6}$/);
    fake.pushDm({ channel: "D0FIXTURE", user: "U061", text: "wrong guess" });
    expect((await fake.waitForSent("D0FIXTURE"))[0]!.text).toMatch(/didn't match/);
    fake.pushDm({ channel: "D0FIXTURE", user: "U061", text: pairing.body.code });
    expect((await fake.waitForSent("D0FIXTURE", 2))[1]!.text).toMatch(/^Paired with /);
    const bound = (await api("GET", `/api/messaging/slack/${binding.id}`)).body.binding;
    expect(bound.chats).toHaveLength(1);
    expect(bound.chats[0]).toMatchObject({ channelId: "D0FIXTURE", enabled: true, userId: "slack:U061" });

    // a paired DM's question reaches the bot and the answer comes back
    fake.pushDm({ channel: "D0FIXTURE", user: "U061", text: "What is 2+2?" });
    expect((await fake.waitForSent("D0FIXTURE", 3))[2]).toMatchObject({ channel: "D0FIXTURE", text: "Four." });
    const thread = (await api("GET", `/api/threads/${bound.chats[0].threadId}/messages?limit=50`)).body.messages as any[];
    expect(thread.find((m) => m.role === "user" && m.text === "What is 2+2?")).toMatchObject({ relayed: true });

    // unpairing stops replies; unbinding drops the socket
    expect((await api("DELETE", `/api/messaging/slack/${binding.id}/chats/D0FIXTURE`)).status).toBe(200);
    fake.pushDm({ channel: "D0FIXTURE", user: "U061", text: "still there?" });
    expect((await fake.waitForSent("D0FIXTURE", 4))[3]!.text).toMatch(/isn't paired/);
    expect((await api("DELETE", `/api/messaging/slack/${binding.id}`)).status).toBe(200);
    for (let i = 0; i < 100 && fake.sockets > 0; i += 1) await new Promise((r) => setTimeout(r, 50));
    expect(fake.sockets).toBe(0);
  }, 120_000);
});
