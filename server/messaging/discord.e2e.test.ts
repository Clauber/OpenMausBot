// The Discord adapter through a real isolated runtime: the actual harness,
// guarded-send path and admin API, with the fake CLI engine as the only
// provider and server/testing/fake-discord.ts standing in for Discord (REST +
// gateway). Nothing here could touch a real server: the fixture only forwards
// DISCORD_API_BASE when it is a loopback URL.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "../../scripts/control-omb.ts";
import { FAKE_BOT_TOKEN, startFakeDiscord, type FakeDiscord } from "../testing/fake-discord.ts";

describe("Discord adapter through an isolated runtime", () => {
  let fixture: VerificationServer;
  let fake: FakeDiscord;
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
  const socketState = async (bindingId: string) => (await api("GET", `/api/messaging/discord/${bindingId}`)).body.binding.socket as { status: string; error?: string } | null;
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
    fake = await startFakeDiscord({ heartbeatMs: 500 });
    scratch = mkdtempSync(join(tmpdir(), "omb-discord-e2e-"));
    const state = join(scratch, "reply-state");
    writeFileSync(state, "");
    fixture = await launchVerificationServer({
      ...process.env,
      DISCORD_API_BASE: fake.url,
      FAKE_CLAUDE_REPLIES: JSON.stringify(["Four."]),
      FAKE_CLAUDE_REPLY_STATE: state,
    });
  }, 30_000);

  afterEach(async () => {
    if (fixture) {
      const evidencePath = `${fixture.info.logPath}.discord.json`;
      writeFileSync(evidencePath, JSON.stringify({ fixture: fixture.info, evidence, fakeSent: fake?.sent, limitation: "Actual runtime and guarded path with the fake engine and a fake Discord (REST + gateway) only. No live accounts or user data." }, null, 2));
      console.info(JSON.stringify({ logPath: fixture.info.logPath, evidencePath }));
      await fixture.close();
    }
    await fake?.stop();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("binds over the gateway, pairs a DM by code, relays the turn, and never echoes the token", async () => {
    const control = async (args: string[]) => (await runControlOmb([...args, "--url", fixture.info.url])) as any;
    const { bot } = await control(["new-bot", "--name", "Discord fixture"]);

    // refusal paths: a bad token, an unknown bot
    const badToken = await api("POST", "/api/messaging/discord", { botId: bot.id, token: "MWrongToken-wrongtoken-wrongtoken-wrongtoken" });
    expect(badToken.status).toBe(400);
    expect(badToken.body.error).toMatch(/401/);
    expect(badToken.body.error).not.toContain(FAKE_BOT_TOKEN);
    expect((await api("POST", "/api/messaging/discord", { botId: "missing", token: FAKE_BOT_TOKEN })).status).toBe(404);

    // the real binding: /users/@me verifies the token, a throwaway
    // /gateway/bot + identify proves the gateway, then the service connects
    expect((await api("POST", "/api/messaging/discord", { botId: bot.id, token: FAKE_BOT_TOKEN })).status).toBe(201);
    const binding = (await api("GET", "/api/messaging/discord")).body.bindings.at(-1);
    expect(binding).toMatchObject({ botId: bot.id, username: "fake_omb_bot" });
    expect(JSON.stringify(await api("GET", "/api/messaging/discord").then((r) => r.body))).not.toContain(FAKE_BOT_TOKEN);
    expect(await waitSocket(binding.id, "connected")).toMatchObject({ status: "connected" });

    // pairing: the code comes from the admin API and is spent by a DM
    const pairing = await api("POST", `/api/messaging/discord/${binding.id}/pairing`, {});
    expect(pairing.body.code).toMatch(/^\d{6}$/);
    fake.pushDm({ channel: "700000000000000777", content: "wrong guess" });
    expect((await fake.waitForSent("700000000000000777"))[0]!.content).toMatch(/didn't match/);
    fake.pushDm({ channel: "700000000000000777", content: pairing.body.code });
    expect((await fake.waitForSent("700000000000000777", 2))[1]!.content).toMatch(/^Paired with /);
    const bound = (await api("GET", `/api/messaging/discord/${binding.id}`)).body.binding;
    expect(bound.chats).toHaveLength(1);
    expect(bound.chats[0]).toMatchObject({ channelId: "700000000000000777", enabled: true, userId: "discord:900000000000000002" });

    // a paired DM's question reaches the bot and the answer comes back
    fake.pushDm({ channel: "700000000000000777", content: "What is 2+2?" });
    expect((await fake.waitForSent("700000000000000777", 3))[2]).toMatchObject({ channel_id: "700000000000000777", content: "Four." });
    const thread = (await api("GET", `/api/threads/${bound.chats[0].threadId}/messages?limit=50`)).body.messages as any[];
    expect(thread.find((m) => m.role === "user" && m.text === "What is 2+2?")).toMatchObject({ relayed: true });

    // unpairing stops replies; unbinding drops the gateway connection
    expect((await api("DELETE", `/api/messaging/discord/${binding.id}/chats/700000000000000777`)).status).toBe(200);
    fake.pushDm({ channel: "700000000000000777", content: "still there?" });
    expect((await fake.waitForSent("700000000000000777", 4))[3]!.content).toMatch(/isn't paired/);
    expect((await api("DELETE", `/api/messaging/discord/${binding.id}`)).status).toBe(200);
    for (let i = 0; i < 100 && fake.sockets > 0; i += 1) await new Promise((r) => setTimeout(r, 50));
    expect(fake.sockets).toBe(0);
  }, 120_000);
});
