import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createTerminalRoutes } from "./terminal.ts";

const adminAuth: RequestAuth = {
  kind: "session",
  session: {
    id: "s1",
    tokenHash: "a".repeat(64),
    label: "test",
    scopes: ["admin"],
    createdAt: 0,
    lastSeenAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
  },
  via: "cookie",
  scopes: ["admin"],
};

function captureRes() {
  const res = {
    headersSent: false,
    writableEnded: false,
    status: 0,
    body: "" as string,
    setHeader() {},
    writeHead(status: number) {
      res.status = status;
      res.headersSent = true;
      return res;
    },
    end(data?: string) {
      res.body = data ?? "";
      res.writableEnded = true;
    },
  };
  return res as unknown as ServerResponse & { status: number; body: string };
}

function routeContext(req: IncomingMessage, res: ServerResponse, auth: RequestAuth) {
  const url = new URL(req.url ?? "/api/terminal", "http://localhost");
  return { req, res, url, path: url.pathname, method: (req.method ?? "GET").toUpperCase(), auth, json, readBody };
}

/** A real server whose handleRequest always authorizes and dispatches only
 * this route — the test's stand-in for index.ts's gate + route table. */
async function startTerminalServer(options: Parameters<typeof createTerminalRoutes>[0]) {
  const terminal = createTerminalRoutes(options);
  const server = createServer((req, res) => {
    void terminal.route(routeContext(req, res, adminAuth));
  });
  terminal.attach(server, async (req, res) => {
    void terminal.route(routeContext(req, res, adminAuth));
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const close = async () => {
    terminal.closeAll();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { terminal, url: () => `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/terminal`, close };
}

/** Collect binary frames until `needle` appears; resolves the joined output.
 * Detaches both listeners when done so a later close cannot reject a settled
 * promise. */
function expectOutput(socket: WebSocket, needle: string, timeoutMs = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${JSON.stringify(needle)}`)), timeoutMs);
    const onMessage = (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return;
      output += data.toString("utf8");
      if (output.includes(needle)) done();
    };
    const onClose = (code: number) => reject(new Error(`socket closed (${code}) before ${JSON.stringify(needle)}`));
    const done = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      resolve(output);
    };
    socket.on("message", onMessage);
    socket.on("close", onClose);
  });
}

describe("terminal routes", () => {
  it("answers the capability probe with the chosen shell", async () => {
    const fake = { spawn: () => { throw new Error("not used"); } } as unknown as typeof import("node-pty");
    const { terminal, url, close } = await startTerminalServer({ loadPty: async () => fake, shell: () => "/bin/ksh" });
    try {
      const res = captureRes();
      await terminal.route(routeContext({ url: "/api/terminal", headers: {} } as IncomingMessage, res, adminAuth));
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ available: true, shell: "/bin/ksh" });
      expect(url()).toContain("/api/terminal");
    } finally {
      await close();
    }
  });

  it("refuses non-admin sessions and non-GET methods", async () => {
    const { terminal, close } = await startTerminalServer({ loadPty: async () => null });
    try {
      const memberAuth: RequestAuth = { ...adminAuth, scopes: ["client"], session: { ...adminAuth.session, scopes: ["client"] } };
      const denied = captureRes();
      await terminal.route(routeContext({ url: "/api/terminal", headers: {} } as IncomingMessage, denied, memberAuth));
      expect(denied.status).toBe(403);

      const wrongMethod = captureRes();
      await terminal.route(routeContext({ url: "/api/terminal", method: "POST", headers: {} } as IncomingMessage, wrongMethod, adminAuth));
      expect(wrongMethod.status).toBe(405);
    } finally {
      await close();
    }
  });

  it("echoes input through a real PTY and honors resize", async () => {
    const home = mkdtempSync(join(tmpdir(), "omb-terminal-"));
    const { terminal, url, close } = await startTerminalServer({ shell: () => "/bin/cat", cwd: () => home });
    try {
      const socket = new WebSocket(url());
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      socket.send(JSON.stringify({ type: "resize", cols: 40, rows: 10 }));
      const first = expectOutput(socket, "ping");
      socket.send(JSON.stringify({ type: "input", data: "ping" }));
      await first;
      expect(terminal.liveSessions()).toBe(1);

      // The shell dies with the socket, not after it.
      const closed = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("server never closed the socket")), 5_000);
        socket.once("close", () => { clearTimeout(timer); resolve(); });
      });
      socket.close();
      await closed;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(terminal.liveSessions()).toBe(0);
    } finally {
      await close();
    }
  });

  it("closes the relay when the shell exits", async () => {
    const { terminal, url, close } = await startTerminalServer({ shell: () => "/bin/true" });
    try {
      const socket = new WebSocket(url());
      const outcome = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      expect(await outcome).toBe(1000);
      expect(terminal.liveSessions()).toBe(0);
    } finally {
      await close();
    }
  });
});
