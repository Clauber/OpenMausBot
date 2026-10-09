// Owner terminal: a VS Code-style shell (Ctrl+`) in the web app, running on
// the server this process serves. One WebSocket per shell; the PTY lives and
// dies with the socket. Upgrades run through the very same authentication and
// maintenance gates as HTTP — only this route detaches the response socket.
//
// The wire is asymmetric on purpose: text frames carry JSON control
// (input, resize, server error), binary frames carry raw PTY output.
//
// node-pty is an optional dependency and never bundled (a native module
// cannot live inside dist-server). When it is absent the route degrades to
// "available: false" and the panel explains itself; the packaged desktop app
// is the expected case.
import { existsSync } from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import { ServerResponse } from "node:http";
import { homedir } from "node:os";
import { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { isSameOrigin } from "../request-auth.ts";
import { PASS, UPGRADE_CLAIMED, type RouteHandler } from "./table.ts";

const ROUTE = /^\/api\/terminal\/?$/;
/** Hard cap on live shells per server process, whatever the session count. */
const MAX_SESSIONS = 4;
/** PTY output bursts (a `yes`, a build log) queue in the socket until the
 * browser drains it; drop bytes rather than growing the queue without bound. */
const SOCKET_BACKPRESSURE_BYTES = 8 * 1024 * 1024;

type PtyModule = typeof import("node-pty");
type IPty = import("node-pty").IPty;

let ptyPromise: Promise<PtyModule | null> | null = null;

/** Resolved once; null means node-pty is not installed or failed to load. */
function loadPty(): Promise<PtyModule | null> {
  ptyPromise ??= import("node-pty")
    // CJS: the ESM namespace carries the API on `default`; a future ESM build
    // of node-pty would export it directly.
    .then((module) => ((module as { default?: PtyModule }).default ?? module) as PtyModule)
    .catch(() => null);
  return ptyPromise;
}

function pickShell(): string {
  const candidates = [process.env.SHELL, "/bin/bash", "/bin/sh"];
  return candidates.find((shellPath) => shellPath && existsSync(shellPath)) ?? "/bin/sh";
}

export function createTerminalRoutes(deps: {
  loadPty?: () => Promise<PtyModule | null>;
  shell?: () => string;
  cwd?: () => string;
  maxSessions?: number;
} = {}) {
  const load = deps.loadPty ?? loadPty;
  const shell = deps.shell ?? pickShell;
  const cwd = deps.cwd ?? homedir;
  const maxSessions = deps.maxSessions ?? MAX_SESSIONS;

  interface Session { pty: IPty; socket: WebSocket; owner: string }
  const sessions = new Set<Session>();
  const upgrades = new Map<IncomingMessage, { socket: Socket; head: Buffer; release: () => void; close: () => void }>();
  const relay = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  let stopped = false;

  /** Intercept `upgrade` on the shared server: buffer eager WebSocket bytes
   * and route the request through handleRequest so auth, hosted-workspace and
   * maintenance gates all apply before this route sees the socket. */
  function attach(server: Server, handle: (req: IncomingMessage, res: ServerResponse) => Promise<unknown>): void {
    server.on("upgrade", (req, socket, head) => {
      let path: string;
      try { path = new URL(req.url ?? "", "http://localhost").pathname; }
      catch { return; }
      if (stopped || !ROUTE.exec(path) || !(socket instanceof Socket)) return;
      (req as { [UPGRADE_CLAIMED]?: boolean })[UPGRADE_CLAIMED] = true;
      const res = new ServerResponse(req);
      res.assignSocket(socket);
      res.setHeader("connection", "close");
      socket.on("error", () => socket.destroy());
      res.once("finish", () => socket.end(() => socket.destroy()));
      const upgrade = { socket, head, release: () => socket.off("data", buffer), close: () => socket.destroy() };
      const buffer = (data: Buffer) => {
        if (upgrade.head.length + data.length > 64 * 1024) socket.destroy();
        else upgrade.head = Buffer.concat([upgrade.head, data]);
      };
      socket.on("data", buffer);
      const endWhileWaiting = () => socket.destroy();
      socket.once("end", endWhileWaiting);
      socket.once("close", () => { upgrade.release(); socket.off("end", endWhileWaiting); upgrades.delete(req); });
      upgrades.set(req, upgrade);
      void handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
        else socket.destroy();
      });
    });
  }

  function forget(session: Session): void {
    sessions.delete(session);
    try { session.pty.kill(); } catch { /* already gone */ }
    if (session.socket.readyState === WebSocket.OPEN) session.socket.close(1000);
  }

  function spawnSession(pty: PtyModule, socket: WebSocket, owner: string): Session | null {
    let session: Session;
    try {
      session = {
        pty: pty.spawn(shell(), [], {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
          cwd: cwd(),
          env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>,
        }),
        socket,
        owner,
      };
    } catch {
      return null;
    }
    sessions.add(session);
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        // Terminal input travels as JSON text; stray binary means a peer
        // speaking another protocol — hang up rather than guess.
        socket.close(1003, "binary frames are output-only");
        forget(session);
        return;
      }
      let message: { type?: string; data?: unknown; cols?: unknown; rows?: unknown };
      try { message = JSON.parse(String(data)); } catch { return; }
      if (message.type === "input" && typeof message.data === "string") {
        session.pty.write(message.data);
      } else if (message.type === "resize"
        && Number.isInteger(message.cols) && (message.cols as number) >= 2 && (message.cols as number) <= 1000
        && Number.isInteger(message.rows) && (message.rows as number) >= 2 && (message.rows as number) <= 1000) {
        try { session.pty.resize(message.cols as number, message.rows as number); } catch { /* shell gone */ }
      }
    });
    socket.on("close", () => forget(session));
    socket.on("error", () => forget(session));
    session.pty.onData((chunk) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > SOCKET_BACKPRESSURE_BYTES) return;
      socket.send(Buffer.from(chunk, "utf8"), { binary: true });
    });
    session.pty.onExit(() => {
      sessions.delete(session);
      if (socket.readyState === WebSocket.OPEN) socket.close(1000);
    });
    return session;
  }

  const route: RouteHandler = async ({ req, res, path, method, auth, json }) => {
    if (!ROUTE.exec(path)) return PASS;
    res.setHeader("cache-control", "private, no-store");
    if (method !== "GET") return json(res, 405, { error: "method not allowed" });
    // Same gate as the desktop viewer: this socket is a shell on the server,
    // so only admin-scope, same-origin callers get past here.
    if (!auth.scopes.includes("admin") || !isSameOrigin(req)) return json(res, 403, { error: "forbidden" });

    if (req.headers.upgrade?.toLowerCase() !== "websocket" || !upgrades.get(req)) {
      // The capability probe the panel uses before showing anything.
      return json(res, 200, { available: (await load()) !== null, shell: shell() });
    }

    const pty = await load();
    if (!pty) return json(res, 501, { error: "The server has no terminal backend installed (node-pty is missing)." });
    if (sessions.size >= maxSessions) return json(res, 429, { error: "Too many terminals are open on this server." });

    const upgrade = upgrades.get(req)!;
    upgrades.delete(req);
    upgrade.release();
    relay.handleUpgrade(req, upgrade.socket, upgrade.head, (socket) => {
      const session = spawnSession(pty, socket, auth.kind === "session" ? auth.session.id : "loopback");
      if (!session) socket.close(1011, "The shell could not start.");
    });
  };

  return {
    route,
    attach,
    /** Kill every live shell: graceful shutdown, and each session's socket. */
    closeAll(): void {
      stopped = true;
      // Set iteration tolerates delete-during-iteration; forget() only ever
      // removes the entry it was handed.
      for (const session of sessions) forget(session);
      for (const upgrade of upgrades.values()) upgrade.close();
    },
    closeForOwner(owner: string): void {
      for (const session of sessions) if (session.owner === owner) forget(session);
    },
    liveSessions(): number {
      return sessions.size;
    },
  };
}
