import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { RequestType, ResponseType, decodeMessage, encodeFrame, encodeMessage, makeFrameDecoder } from "./channel-protocol.ts";
import { connectZcodeChannel, ZcodeChannelError, type ZcodeChannelClient } from "./channel.ts";

const TOKEN = "fake-token-1234567890";

interface Request {
  header: unknown[];
  body: unknown;
}

/** In-process stand-in for the ZCode server: sends Initialize first, then records requests for the test to answer. */
async function startFakeServer(options: { initialize?: boolean } = {}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
  const requests: Request[] = [];
  const waiters: Array<(request: Request) => void> = [];
  const connectionUrls: string[] = [];
  let socket!: WebSocket;
  const accepted = new Promise<void>((resolve) => {
    server.on("connection", (ws, req) => {
      socket = ws;
      connectionUrls.push(req.url ?? "");
      const decode = makeFrameDecoder();
      ws.on("message", (data: Buffer) => {
        for (const payload of decode(data)) {
          const message = decodeMessage(payload) as Request;
          const waiter = waiters.shift();
          if (waiter) waiter(message);
          else requests.push(message);
        }
      });
      if (options.initialize !== false) ws.send(encodeFrame(encodeMessage([ResponseType.Initialize], undefined)));
      resolve();
    });
  });
  return {
    url,
    connectionUrls,
    nextRequest: () => (requests.length > 0 ? Promise.resolve(requests.shift()!) : new Promise<Request>((resolve) => waiters.push(resolve))),
    respond: (header: unknown[], body?: unknown) => socket.send(encodeFrame(encodeMessage(header, body))),
    sendRaw: (bytes: Uint8Array) => socket.send(bytes),
    closeSocket: () => socket.close(),
    accepted,
    stop: () => new Promise<void>((resolve) => (server.clients.forEach((c) => c.terminate()), server.close(() => resolve()))),
  };
}

type Fake = Awaited<ReturnType<typeof startFakeServer>>;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function withFake(options?: { initialize?: boolean }): Promise<Fake> {
  const fake = await startFakeServer(options);
  cleanups.push(fake.stop);
  return fake;
}

async function connected(): Promise<{ fake: Fake; client: ZcodeChannelClient }> {
  const fake = await withFake();
  const client = await connectZcodeChannel({ url: fake.url, token: TOKEN });
  cleanups.push(() => client.close());
  return { fake, client };
}

const failureOf = async (promise: Promise<unknown>): Promise<ZcodeChannelError> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ZcodeChannelError);
    return error as ZcodeChannelError;
  }
  throw new Error("expected a rejection");
};

describe("connectZcodeChannel", () => {
  it("passes the token as a query parameter and waits for Initialize", async () => {
    const { fake } = await connected();
    expect(fake.connectionUrls).toEqual([`/ws?token=${TOKEN}`]);
  });

  it("rejects non-loopback and non-ws urls before opening a socket, without the token", async () => {
    for (const url of ["ws://example.com:80/ws", "ws://10.0.0.5:1/ws", "wss://127.0.0.1:1/ws", "http://127.0.0.1:1/ws", "not a url"]) {
      const error = await failureOf(connectZcodeChannel({ url, token: TOKEN }));
      expect(error.operation).toBe("connect");
      expect(`${error.message} ${JSON.stringify(error)}`).not.toContain(TOKEN);
    }
  });

  it("accepts localhost and [::1] hosts as loopback", async () => {
    // Nothing listens there, so the connect fails later with the socket category, never the loopback check.
    for (const url of ["ws://localhost:1/ws", "ws://[::1]:1/ws"]) {
      const error = await failureOf(connectZcodeChannel({ url, token: TOKEN, connectTimeoutMs: 2000 }));
      expect(error.operation).not.toBe("connect");
      expect(`${error.message} ${JSON.stringify(error)}`).not.toContain(TOKEN);
    }
  });

  it("fails with an initialize timeout when the server never sends Initialize", async () => {
    const fake = await withFake({ initialize: false });
    const error = await failureOf(connectZcodeChannel({ url: fake.url, token: TOKEN, connectTimeoutMs: 100 }));
    expect([error.operation, error.detail]).toEqual(["initialize", "timeout"]);
  });

  it("fails when the socket closes before Initialize", async () => {
    const fake = await withFake({ initialize: false });
    const pending = failureOf(connectZcodeChannel({ url: fake.url, token: TOKEN }));
    await fake.accepted;
    fake.closeSocket();
    expect((await pending).operation).toBe("closed");
  });
});

describe("call", () => {
  it("sends a call request and resolves with the decoded result", async () => {
    const { fake, client } = await connected();
    const result = client.call("model-selection", "getView", ["a", 1]);
    const request = await fake.nextRequest();
    expect(request.header).toEqual([RequestType.Promise, 0, "model-selection", "getView"]);
    expect(request.body).toEqual(["a", 1]);
    fake.respond([ResponseType.PromiseSuccess, 0], { revision: 4, providers: [] });
    expect(await result).toEqual({ revision: 4, providers: [] });
  });

  it("defaults call arguments to an empty array", async () => {
    const { fake, client } = await connected();
    void client.call("setting", "get").catch(() => {});
    expect((await fake.nextRequest()).body).toEqual([]);
  });

  it("matches concurrent responses to their calls by id", async () => {
    const { fake, client } = await connected();
    const first = client.call("c", "one");
    const second = client.call("c", "two");
    await fake.nextRequest();
    await fake.nextRequest();
    fake.respond([ResponseType.PromiseSuccess, 1], "second");
    fake.respond([ResponseType.PromiseSuccess, 0], "first");
    expect(await first).toBe("first");
    expect(await second).toBe("second");
  });

  it("maps error responses without the remote message", async () => {
    const { fake, client } = await connected();
    const failure = failureOf(client.call("c", "boom"));
    await fake.nextRequest();
    fake.respond([ResponseType.PromiseError, 0], { name: "TypeError", message: "secret path /home/x", code: "E_BOOM" });
    const error = await failure;
    expect(error.operation).toBe("call");
    expect(error.detail).toBe("TypeError (E_BOOM)");
    expect(error.message).toBe("ZCode channel call failed: TypeError (E_BOOM)");
    expect(error.message).not.toContain("secret");
  });

  it("maps error object responses to a fixed detail", async () => {
    const { fake, client } = await connected();
    const failure = failureOf(client.call("c", "boom"));
    await fake.nextRequest();
    fake.respond([ResponseType.PromiseErrorObj, 0], { anything: "goes", message: "secret" });
    const error = await failure;
    expect(error.detail).toBe("remote error");
    expect(error.message).not.toContain("secret");
  });

  it("sends a cancel frame and rejects when the signal aborts", async () => {
    const { fake, client } = await connected();
    const controller = new AbortController();
    const failure = failureOf(client.call("c", "slow", [], { signal: controller.signal }));
    await fake.nextRequest();
    controller.abort();
    expect((await failure).detail).toBe("aborted");
    expect((await fake.nextRequest()).header).toEqual([RequestType.PromiseCancel, 0]);
  });

  it("rejects an already aborted signal without sending", async () => {
    const { fake, client } = await connected();
    const controller = new AbortController();
    controller.abort();
    expect((await failureOf(client.call("c", "m", [], { signal: controller.signal }))).detail).toBe("aborted");
    const next = client.call("c", "after");
    expect((await fake.nextRequest()).header).toEqual([RequestType.Promise, 0, "c", "after"]);
    fake.respond([ResponseType.PromiseSuccess, 0], null);
    await next;
  });

  it("fails an unserializable call without closing the client", async () => {
    const { fake, client } = await connected();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect((await failureOf(client.call("c", "m", [circular]))).operation).toBe("encode");
    const ok = client.call("c", "ok");
    await fake.nextRequest();
    fake.respond([ResponseType.PromiseSuccess, 1], "fine");
    expect(await ok).toBe("fine");
  });

  it("fails pending calls when the socket closes, and later calls fail fast", async () => {
    const { fake, client } = await connected();
    const pending = failureOf(client.call("c", "m"));
    await fake.nextRequest();
    fake.closeSocket();
    expect((await pending).operation).toBe("closed");
    await client.closed;
    expect((await failureOf(client.call("c", "m"))).operation).toBe("closed");
  });

  it("fails calls with a fixed decode error after a malformed frame", async () => {
    const { fake, client } = await connected();
    const pending = failureOf(client.call("c", "m"));
    await fake.nextRequest();
    fake.respond([ResponseType.PromiseSuccess]);
    const error = await pending;
    expect([error.operation, error.detail]).toEqual(["decode", "malformed frame"]);
    await client.closed;
  });

  it("close() fails pending calls and resolves closed", async () => {
    const { fake, client } = await connected();
    const pending = failureOf(client.call("c", "m"));
    await fake.nextRequest();
    client.close();
    expect((await pending).operation).toBe("closed");
    await client.closed;
  });
});

describe("listen", () => {
  it("delivers events and sends a dispose frame once", async () => {
    const { fake, client } = await connected();
    const seen: unknown[] = [];
    const dispose = client.listen("zcode-agent", "onDynamicSessionEvent", { s: 1 }, (value) => seen.push(value));
    const request = await fake.nextRequest();
    expect(request.header).toEqual([RequestType.EventListen, 0, "zcode-agent", "onDynamicSessionEvent"]);
    expect(request.body).toEqual({ s: 1 });
    fake.respond([ResponseType.EventFire, 0], { n: 1 });
    fake.respond([ResponseType.EventFire, 0], { n: 2 });
    await expect.poll(() => seen.length).toBe(2);
    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
    dispose();
    dispose();
    expect((await fake.nextRequest()).header).toEqual([RequestType.EventDispose, 0]);
    const after = client.call("c", "m");
    expect((await fake.nextRequest()).header).toEqual([RequestType.Promise, 1, "c", "m"]);
    fake.respond([ResponseType.PromiseSuccess, 1], null);
    await after;
  });

  it("stops delivering after dispose", async () => {
    const { fake, client } = await connected();
    const seen: unknown[] = [];
    const dispose = client.listen("c", "onX", undefined, (value) => seen.push(value));
    await fake.nextRequest();
    dispose();
    await fake.nextRequest();
    fake.respond([ResponseType.EventFire, 0], 1);
    const probe = client.call("c", "probe");
    await fake.nextRequest();
    fake.respond([ResponseType.PromiseSuccess, 1], null);
    await probe;
    expect(seen).toEqual([]);
  });

  it("calls onEnd once when the socket closes", async () => {
    const { fake, client } = await connected();
    const ends: Array<ZcodeChannelError | undefined> = [];
    client.listen("c", "onX", undefined, () => {}, (error) => ends.push(error));
    await fake.nextRequest();
    fake.closeSocket();
    await client.closed;
    expect(ends).toEqual([undefined]);
  });

  it("calls onEnd with the error when the stream breaks, and when listening on a closed client", async () => {
    const { fake, client } = await connected();
    const ends: Array<ZcodeChannelError | undefined> = [];
    client.listen("c", "onX", undefined, () => {}, (error) => ends.push(error));
    await fake.nextRequest();
    fake.sendRaw(encodeFrame(Uint8Array.of(99)));
    await client.closed;
    expect(ends).toHaveLength(1);
    expect(ends[0]?.operation).toBe("decode");
    const late: Array<ZcodeChannelError | undefined> = [];
    client.listen("c", "onX", undefined, () => {}, (error) => late.push(error));
    await Promise.resolve();
    expect(late).toHaveLength(1);
    expect(late[0]?.operation).toBe("decode");
  });
});

// Opt-in: needs a running ZCode server (ZCODE_CHANNEL_TEST_URL and ZCODE_CHANNEL_TEST_TOKEN).
const liveUrl = process.env.ZCODE_CHANNEL_TEST_URL;
const liveToken = process.env.ZCODE_CHANNEL_TEST_TOKEN;

describe.skipIf(!liveUrl || !liveToken)("against a real ZCode server", () => {
  it("reads settings and surfaces remote errors for unknown methods", async () => {
    const client = await connectZcodeChannel({ url: liveUrl!, token: liveToken! });
    try {
      expect(typeof (await client.call("setting", "get"))).toBe("object");
      expect((await failureOf(client.call("setting", "noSuchMethod"))).operation).toBe("call");
    } finally {
      client.close();
    }
  });
});
