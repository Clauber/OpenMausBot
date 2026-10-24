#!/usr/bin/env node
// A loopback stand-in for Discord's REST API and gateway, for tests and the
// isolated fixture. Implements GET /gateway/bot, GET /users/@me,
// POST /channels/:id/messages, POST /channels/:id/typing, plus a WebSocket
// gateway: hello → identify → READY, heartbeat acks, MESSAGE_CREATE fan-out
// (feed one with POST /push). Sends are captured in memory. The token is the
// fake constant below — anything else is refused, like Discord refuses
// unknown tokens. Self-contained on purpose (node built-ins + `ws`, already a
// project dependency).
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";

export const FAKE_BOT_TOKEN = "MFAKE-fake-discord-bot-token-0123456789abcdefghijklmnop";
export const FAKE_BOT_USER_ID = "900000000000000001";
export const FAKE_HUMAN_USER_ID = "900000000000000002";

export interface FakeDiscordSend { token: string; channel_id: string; content: string; at: number }
export interface FakeDiscord {
  /** REST + gateway base (DISCORD_API_BASE). */
  url: string;
  sent: FakeDiscordSend[];
  typingCalls: Array<{ token: string; channel_id: string; at: number }>;
  gatewayBotCalls: Array<{ token: string; at: number }>;
  usersMeCalls: Array<{ token: string; at: number }>;
  identifies: number;
  heartbeats: number;
  sockets: number;
  /** Fan a MESSAGE_CREATE out to every connected gateway socket. A `guildId`
   * makes it a guild message (which the adapter must ignore). */
  pushDm(dm: { channel: string; user?: string; username?: string; content: string; id?: string; guildId?: string }): void;
  /** Make /gateway/bot answer 401 (bad token). */
  refuseAuth(): void;
  allowAuth(): void;
  /** Make the gateway answer identify with invalid session (op 9, d:false). */
  refuseIdentify(): void;
  allowIdentify(): void;
  /** Send a reconnect request (op 7) to every socket. */
  requestReconnect(): void;
  /** Close every gateway socket abruptly (no close code). */
  dropSockets(): void;
  /** Wait until `count` messages exist for `channel`, and return them. */
  waitForSent(channel: string, count?: number, timeoutMs?: number): Promise<FakeDiscordSend[]>;
  stop(): Promise<void>;
}

export async function startFakeDiscord(options: { port?: number; heartbeatMs?: number } = {}): Promise<FakeDiscord> {
  const sent: FakeDiscord["sent"] = [];
  const typingCalls: FakeDiscord["typingCalls"] = [];
  const gatewayBotCalls: FakeDiscord["gatewayBotCalls"] = [];
  const usersMeCalls: FakeDiscord["usersMeCalls"] = [];
  const clients = new Set<WebSocket>();
  let refuseAuth = false;
  let refuseIdentify = false;
  let identifies = 0;
  let heartbeats = 0;
  let nextMessageId = 1000000000000000000;
  let seq = 1;
  const reply = (res: import("node:http").ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    if (body !== undefined) res.end(JSON.stringify(body));
    else res.end();
  };
  const tokenOf = (req: import("node:http").IncomingMessage) => /^Bot (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // Test/fixture aid: deliver an inbound DM from outside this process.
    if (req.method === "POST" && url.pathname === "/push") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { channel?: string; user?: string; username?: string; content?: string };
      pushDm({ channel: String(body.channel ?? "D0"), user: body.user, username: body.username, content: String(body.content ?? "") });
      return reply(res, 200, { ok: true });
    }
    const token = tokenOf(req);
    if (!token || token !== FAKE_BOT_TOKEN || refuseAuth) return reply(res, 401, { message: "401: Unauthorized", code: 0 });
    if (req.method === "GET" && url.pathname === "/gateway/bot") {
      gatewayBotCalls.push({ token, at: Date.now() });
      return reply(res, 200, { url: `ws://127.0.0.1:${port}/gateway?v=10&encoding=json`, shards: 1, session_start_limit: { total: 1000, remaining: 998, reset_after: 86400000, max_concurrency: 1 } });
    }
    if (req.method === "GET" && url.pathname === "/users/@me") {
      usersMeCalls.push({ token, at: Date.now() });
      return reply(res, 200, { id: FAKE_BOT_USER_ID, username: "fake_omb_bot", bot: true, discriminator: "0" });
    }
    const message = url.pathname.match(/^\/channels\/(\d+)\/messages$/);
    if (req.method === "POST" && message) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      let body: Record<string, any> = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { /* empty */ }
      const content = String(body.content ?? "");
      if (!content) return reply(res, 400, { message: "Cannot send an empty message", code: 50006 });
      if (content.length > 2000) return reply(res, 400, { message: "Invalid Form Body\ncontent: Must be 2000 or fewer in length.", code: 50035 });
      sent.push({ token, channel_id: message[1]!, content, at: Date.now() });
      return reply(res, 200, { id: `${nextMessageId++}`, channel_id: message[1]!, author: { id: FAKE_BOT_USER_ID, username: "fake_omb_bot", bot: true }, content });
    }
    const typing = url.pathname.match(/^\/channels\/(\d+)\/typing$/);
    if (req.method === "POST" && typing) {
      typingCalls.push({ token, channel_id: typing[1]!, at: Date.now() });
      return reply(res, 204);
    }
    return reply(res, 404, { message: "404: Not Found", code: 0 });
  });
  const wss = new WebSocketServer({ server, path: "/gateway" });
  wss.on("connection", (socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    // The gateway speaks first: hello with the heartbeat contract.
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: options.heartbeatMs ?? 41_250, _trace: ["fake-discord"] } }));
    socket.on("message", (data) => {
      let payload: { op?: number; d?: { token?: string; session_id?: string; seq?: number } };
      try { payload = JSON.parse(String(data)); } catch { return; }
      if (payload.op === 2) {
        identifies += 1;
        if (refuseIdentify) return socket.send(JSON.stringify({ op: 9, d: false }));
        socket.send(JSON.stringify({
          op: 0, t: "READY", s: seq++, d: {
            v: 10, user: { id: FAKE_BOT_USER_ID, username: "fake_omb_bot", bot: true, discriminator: "0" },
            session_id: `fake-session-${identifies}`, resume_gateway_url: `ws://127.0.0.1:${port}/gateway`,
            application: { id: "800000000000000009", flags: 0 },
          },
        }));
        return;
      }
      if (payload.op === 1) {
        heartbeats += 1;
        socket.send(JSON.stringify({ op: 11 }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const fanOut = (payload: unknown) => {
    for (const socket of clients) if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
  };
  const pushDm: FakeDiscord["pushDm"] = (dm) => {
    fanOut({
      op: 0, t: "MESSAGE_CREATE", s: seq++,
      d: {
        id: dm.id ?? `${nextMessageId++}`, channel_id: dm.channel,
        author: { id: dm.user ?? FAKE_HUMAN_USER_ID, username: dm.username ?? "clauber", discriminator: "0" },
        content: dm.content, channel_type: 1,
        ...(dm.guildId ? { guild_id: dm.guildId, member: {} } : {}),
      },
    });
  };
  return {
    url: `http://127.0.0.1:${port}`,
    sent, typingCalls, gatewayBotCalls, usersMeCalls,
    get identifies() { return identifies; },
    get heartbeats() { return heartbeats; },
    get sockets() { return clients.size; },
    pushDm,
    refuseAuth() { refuseAuth = true; },
    allowAuth() { refuseAuth = false; },
    refuseIdentify() { refuseIdentify = true; },
    allowIdentify() { refuseIdentify = false; },
    requestReconnect() { fanOut({ op: 7, d: null }); },
    dropSockets() { for (const socket of clients) socket.terminate(); },
    async waitForSent(channel, count = 1, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const mine = sent.filter((m) => m.channel_id === channel);
        if (mine.length >= count) return mine;
        if (Date.now() > deadline) throw new Error(`fake Discord: timed out waiting for ${count} message(s) to ${channel}; have ${mine.length}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    stop() {
      for (const socket of clients) socket.terminate();
      wss.close();
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// `node server/testing/fake-discord.ts [port]` prints the base URL for
// DISCORD_API_BASE and runs until killed.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fake = await startFakeDiscord({ port: Number(process.argv[2]) || 0 });
  process.stdout.write(`${fake.url}\n`);
}
