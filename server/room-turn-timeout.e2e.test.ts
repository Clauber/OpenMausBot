import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");

let child: ChildProcess;
let home = "";
let base = "";
let stderr = "";
let slowGate = "";

type StateMessage = {
  id: string;
  kind: string;
  role?: string;
  text?: string;
  from?: { botId?: string; name?: string };
  tool?: { name?: string; ok?: boolean };
};

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
};

const fixture = (displayName: string, environment: Record<string, string>) => ({
  driver: "claudeAgent",
  displayName,
  environment,
  config: { cli: FAKE_CLAUDE },
});

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-room-turn-timeout-"));
  const data = join(home, ".openmausbot");
  const staticDir = join(home, "static");
  mkdirSync(data, { recursive: true });
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Room turn timeout test</title>");
  writeFileSync(join(staticDir, "assets", "smoke.css"), "body{}");
  slowGate = join(home, "slow-finish");
  writeFileSync(join(data, "config.json"), JSON.stringify({
    // A short global default keeps the proof to seconds: the ceiling must fire at one minute ...
    rooms: { turnTimeoutMinutes: 1 },
    instances: {
      // Holds its turn open until the gate file exists; its closing reply echoes the prompt it was given.
      patient: fixture("Patient fixture", { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: slowGate }),
    },
  }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(port),
      OMB_WEBHOOK_PORT: String(port + 1),
      OMB_STATIC_DIR: staticDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${stderr}`);
    try {
      if ((await fetch(`${base}/api/health`)).status === 200) break;
    } catch {
    }
    if (Date.now() >= deadline) throw new Error(`server never became healthy: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}, 30_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

const createBot = async (name: string, instanceId: string) =>
  (await api("POST", "/api/bots", {
    name,
    modelSelection: { instanceId, model: "claude-sonnet-5" },
    requireAvailableModel: true,
  })).body.bot;

const createRoom = async (name: string, memberIds: string[]) =>
  (await api("POST", "/api/groups", {
    name,
    memberIds,
    setup: { bulletin: "", defaultResponder: { kind: "member", botId: memberIds[0] } },
  })).body.group;

const snapshot = async (groupId: string) => {
  const state = (await api("GET", "/api/bots?messages=60")).body;
  const room = state.groups.find((group: { id: string }) => group.id === groupId);
  const messages: StateMessage[] = room?.messages ?? [];
  return { state, room, messages };
};

const send = async (roomId: string, text: string) =>
  expect((await api("POST", `/api/groups/${roomId}/messages`, { text })).status).toBe(202);

const timeoutChip = (messages: StateMessage[], botName: string, minutes: number) =>
  messages.find(
    (message) =>
      message.kind === "activity" &&
      message.tool?.ok === false &&
      message.tool?.name === `${botName}'s room turn exceeded ${minutes} minute${minutes === 1 ? "" : "s"} and was stopped`,
  );

const cleanup = async (roomId: string | undefined, botIds: string[]) => {
  writeFileSync(slowGate, "cleanup");
  if (roomId) await api("POST", `/api/groups/${roomId}/interrupt`, {}).catch(() => undefined);
  if (roomId) await api("DELETE", `/api/groups/${roomId}`).catch(() => undefined);
  for (const botId of botIds) await api("DELETE", `/api/bots/${botId}`).catch(() => undefined);
};

describe("room turn ceiling", () => {
  it(
    "stops a held turn at the global default and says so",
    { timeout: 150_000 },
    async () => {
      const pat = await createBot("Pat", "patient");
      const room = await createRoom("Ceiling room", [pat.id]);
      try {
        rmSync(slowGate, { force: true });
        await send(room.id, "@Pat start the long job");
        await expect.poll(async () => (await snapshot(room.id)).room?.busyBotId, { timeout: 15_000 }).toBe(pat.id);

        await expect.poll(
          async () => {
            const { room: current, messages } = await snapshot(room.id);
            return { chip: Boolean(timeoutChip(messages, "Pat", 1)), busy: current?.busyBotId, working: current?.working };
          },
          { timeout: 90_000, interval: 1_000 },
        ).toEqual({ chip: true, busy: null, working: false });
      } finally {
        await cleanup(room?.id, [pat.id]);
      }
    },
  );

  it(
    "a conversation limit of 30 minutes lets the same held turn finish",
    { timeout: 180_000 },
    async () => {
      const pat = await createBot("Pia", "patient");
      const room = await createRoom("Override room", [pat.id]);
      try {
        const patched = await api("PATCH", `/api/groups/${room.id}/tasks/${room.threadId}`, { turnTimeoutMinutes: 30 });
        expect(patched.status).toBe(200);
        expect(patched.body.task?.turnTimeoutMinutes).toBe(30);
        const { state } = await snapshot(room.id);
        const visibleRoom = state.groups.find((group: { id: string }) => group.id === room.id);
        expect(visibleRoom?.tasks?.find((task: { threadId: string }) => task.threadId === room.threadId)?.turnTimeoutMinutes).toBe(30);

        rmSync(slowGate, { force: true });
        const dispatchedAt = Date.now();
        await send(room.id, "@Pia start the long job");
        await expect.poll(async () => (await snapshot(room.id)).room?.busyBotId, { timeout: 15_000 }).toBe(pat.id);

        // Outlive the one-minute global default that stopped the previous test's turn.
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, dispatchedAt + 70_000 - Date.now())));
        const held = await snapshot(room.id);
        expect(held.room?.busyBotId).toBe(pat.id);
        expect(timeoutChip(held.messages, "Pia", 1)).toBeUndefined();

        writeFileSync(slowGate, "finish");
        await expect.poll(
          async () => {
            const { room: current, messages } = await snapshot(room.id);
            return {
              busy: current?.busyBotId,
              working: current?.working,
              replied: messages.some((message) => message.kind === "text" && message.from?.botId === pat.id),
              timedOut: Boolean(timeoutChip(messages, "Pia", 1)),
            };
          },
          { timeout: 30_000, interval: 1_000 },
        ).toEqual({ busy: null, working: false, replied: true, timedOut: false });
      } finally {
        await cleanup(room?.id, [pat.id]);
      }
    },
  );
});
