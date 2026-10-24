#!/usr/bin/env node
// A loopback stand-in for Slack's Web API and Socket Mode, for tests and the
// isolated fixture. Implements POST /api/auth.test, /api/chat.postMessage and
// /api/apps.connections.open, plus a WebSocket server for the Socket Mode
// link (hello on connect, envelope fan-out, ack capture, disconnect reasons).
// Sends are captured in memory; pushDm() feeds an im message event to every
// connected socket the way Slack would. Tokens are the fake constants below —
// anything else is refused, like Slack refuses unknown tokens.
// Self-contained apart from `ws`, already a project dependency (terminal).
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";

export const FAKE_BOT_TOKEN = "xoxb-fake-000000000000-111111111111-Zzzautomatttoken";
export const FAKE_APP_TOKEN = "xapp-1-F00000000000-999999999999-Aaaautomatttoken";

export interface FakeSlackSend { token: string; channel: string; text: string; thread_ts?: string; at: number }
export interface FakeSlackAck { envelope_id: string; at: number }

export interface FakeSlack {
  /** Web API base (SLACK_API_BASE). */
  url: string;
  /** chat.postMessage calls that passed auth. */
  sent: FakeSlackSend[];
  acks: FakeSlackAck[];
  connectionsOpenCalls: Array<{ token: string; at: number }>;
  authTestCalls: Array<{ token: string; at: number }>;
  sockets: number;
  /** Fan a `message` im event out to every connected socket. */
  pushDm(dm: { channel: string; user: string; text: string; ts?: string }): void;
  /** Fan an arbitrary envelope out to every connected socket. */
  pushEnvelope(type: string, payload: unknown): void;
  /** Answer every apps.connections.open with not_allowed_token_type. */
  refuseConnectionsOpen(): void;
  allowConnectionsOpen(): void;
  /** Send a disconnect envelope to every socket (default: refresh_requested). */
  disconnectAll(reason?: string): void;
  /** Wait until `count` messages exist for `channel`, and return them. */
  waitForSent(channel: string, count?: number, timeoutMs?: number): Promise<FakeSlackSend[]>;
  stop(): Promise<void>;
}

export async function startFakeSlack(options: { port?: number } = {}): Promise<FakeSlack> {
  const sent: FakeSlack["sent"] = [];
  const acks: FakeSlack["acks"] = [];
  const connectionsOpenCalls: FakeSlack["connectionsOpenCalls"] = [];
  const authTestCalls: FakeSlack["authTestCalls"] = [];
  const clients = new Set<WebSocket>();
  let refuseConnections = false;
  let nextEnvelopeId = 1;
  let nextTicket = 1;
  let nextTs = 1;
  const reply = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const bearer = (req: import("node:http").IncomingMessage) => /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // Test/fixture aid: deliver an inbound DM from outside this process.
    if (req.method === "POST" && url.pathname === "/push") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { channel?: string; user?: string; text?: string; ts?: string };
      pushDm({ channel: String(body.channel ?? "D0"), user: String(body.user ?? "U0"), text: String(body.text ?? ""), ...(body.ts ? { ts: body.ts } : {}) });
      return reply(res, 200, { ok: true });
    }
    if (req.method !== "POST") return reply(res, 404, { ok: false, error: "not_found" });
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    let body: Record<string, any> = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { /* empty */ }
    const token = bearer(req);
    // The client composes `${base}/${method}` where the real base already
    // ends in /api (https://slack.com/api), so paths here carry no /api.
    switch (url.pathname) {
      case "/auth.test": {
        authTestCalls.push({ token, at: Date.now() });
        if (token !== FAKE_BOT_TOKEN) return reply(res, 200, { ok: false, error: "invalid_auth" });
        return reply(res, 200, { ok: true, team_id: "T0FAKE01TEAM", team: "Fake Workspace", user_id: "U0FAKEBOTUSER", user: "fake_omb_bot", bot_id: "B0FAKEBOTID0" });
      }
      case "/chat.postMessage": {
        if (token !== FAKE_BOT_TOKEN) return reply(res, 200, { ok: false, error: "invalid_auth" });
        const text = String(body.text ?? "");
        if (text.length > 40_000) return reply(res, 200, { ok: false, error: "msg_too_long" });
        const ts = `1700000000.${String(nextTs++).padStart(6, "0")}`;
        sent.push({ token, channel: String(body.channel ?? ""), text, ...(body.thread_ts ? { thread_ts: String(body.thread_ts) } : {}), at: Date.now() });
        return reply(res, 200, { ok: true, channel: String(body.channel ?? ""), ts });
      }
      case "/apps.connections.open": {
        connectionsOpenCalls.push({ token, at: Date.now() });
        if (token !== FAKE_APP_TOKEN) return reply(res, 200, { ok: false, error: "not_allowed_token_type" });
        if (refuseConnections) return reply(res, 200, { ok: false, error: "not_allowed_token_type" });
        return reply(res, 200, { ok: true, url: `ws://127.0.0.1:${port}/link?ticket=${nextTicket++}` });
      }
      default: return reply(res, 404, { ok: false, error: "not_found" });
    }
  });
  const wss = new WebSocketServer({ server, path: "/link" });
  wss.on("connection", (socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    // Slack says hello once the link is up; the service treats hello as ready.
    socket.send(JSON.stringify({ type: "hello", num_connections: 1, debug_info: { host: "fake-slack", build_number: 0, approximate_connection_time: 18000 } }));
    socket.on("message", (data) => {
      let parsed: { envelope_id?: string };
      try { parsed = JSON.parse(String(data)); } catch { return; }
      if (typeof parsed.envelope_id === "string") acks.push({ envelope_id: parsed.envelope_id, at: Date.now() });
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const fanOut = (payload: unknown) => {
    for (const socket of clients) if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
  };
  const pushEnvelope = (type: string, payload: unknown) => {
    fanOut({ envelope_id: `evt.${nextEnvelopeId++}`, type, payload, accepts_response_payload: false });
  };
  const pushDm = (dm: { channel: string; user: string; text: string; ts?: string }) => {
    const ts = dm.ts ?? `1700000099.${String(nextTs++).padStart(6, "0")}`;
    pushEnvelope("events_api", {
      type: "event_callback", team_id: "T0FAKE01TEAM",
      event: { type: "message", channel_type: "im", channel: dm.channel, user: dm.user, text: dm.text, ts, event_ts: ts },
    });
  };
  return {
    url: `http://127.0.0.1:${port}`,
    sent, acks, connectionsOpenCalls, authTestCalls,
    get sockets() { return clients.size; },
    pushDm,
    pushEnvelope,
    refuseConnectionsOpen() { refuseConnections = true; },
    allowConnectionsOpen() { refuseConnections = false; },
    disconnectAll(reason = "refresh_requested") { fanOut({ type: "disconnect", reason }); },
    async waitForSent(channel, count = 1, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const mine = sent.filter((m) => m.channel === channel);
        if (mine.length >= count) return mine;
        if (Date.now() > deadline) throw new Error(`fake Slack: timed out waiting for ${count} message(s) to ${channel}; have ${mine.length}`);
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

// `node server/testing/fake-slack.ts [port]` prints the base URL for
// SLACK_API_BASE and runs until killed.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fake = await startFakeSlack({ port: Number(process.argv[2]) || 0 });
  process.stdout.write(`${fake.url}\n`);
}
