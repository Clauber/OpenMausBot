import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR, saveConfig } from "../config.ts";
import { Store } from "../store.ts";
import { workspaceDir, TASK_WORKSPACES_DIR } from "../workspace.ts";
import { createFleetInternalRoutes } from "./fleet-internal.ts";

beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

function fixture() {
  const store = new Store(() => ({ instanceId: "claude", model: "test" }));
  const master = store.createBot({ name: "Dr. EggBot", section: "Leadership" });
  store.setChiefOfStaff(master.id);
  const target = store.createBot({ name: "St. Paul", section: "Mission", cwd: "/tmp/mission-project" });
  saveConfig({ masterChiefOfStaffBotId: master.id, masterChiefOfStaffRevision: "one" });
  const privateThreads = new Set<string>();
  const route = createFleetInternalRoutes({ store, fullAccess: () => false, invokeApproval: () => false,
    canReadThread: threadId => !privateThreads.has(threadId) });
  const call = async (body: unknown, sender = master, guestDriven = false) => {
    let result: { status: number; body: unknown } = { status: 404, body: null };
    const res = new ServerResponse(new IncomingMessage(new Socket()));
    await route({ method: "POST", path: "/api/internal/fleet/bot-folders", res, json: (_res, status, value) => { result = { status, body: JSON.parse(JSON.stringify(value)) }; },
      sender, threadId: sender.threadId, guestDriven, readBody: async () => body, requireActive: () => {} });
    return result;
  };
  return { store, master, target, privateThreads, call };
}

it("refuses guest-origin handoff authority even in an owner-opened Master thread", async () => {
  const f = fixture();
  expect(await f.call({ targetBotId: f.target.id }, f.master, true)).toMatchObject({ status: 403 });
});

it("omits configured folders overlapping a private task in either direction", async () => {
  const f = fixture();
  const guest = f.store.createTask(f.target.id, "Guest task", false)!;
  f.store.patchTask(f.target.id, guest.threadId, { cwd: "/tmp/private/..guest" });
  f.privateThreads.add(guest.threadId);
  for (const cwd of ["/tmp/private", "/tmp/private/..guest/child"]) {
    f.store.patchBot(f.target.id, { cwd });
    const result = await f.call({ targetBotId: f.target.id });
    expect(result.status).toBe(200);
    expect(result.body).not.toHaveProperty("configuredProjectFolder");
  }
  f.store.patchBot(f.target.id, { cwd: "/tmp/private-sibling" });
  expect(await f.call({ targetBotId: f.target.id })).toMatchObject({ body: { configuredProjectFolder: "/tmp/private-sibling" } });
});

it("rejects an arbitrary path alongside an otherwise valid bot id", async () => {
  const f = fixture();
  expect(await f.call({ targetBotId: f.target.id, path: "/etc" })).toMatchObject({ status: 400 });
});

it("discovers another team's folders without requiring Full Access", async () => {
  const f = fixture();
  const task = f.store.createTask(f.target.id, "Project task", false)!;
  f.store.patchTask(f.target.id, task.threadId, { cwd: "/tmp/mission-task" });
  expect(await f.call({ targetBotId: f.target.id })).toMatchObject({ status: 200, body: {
    botId: f.target.id, sharedBotFolder: workspaceDir(f.target.id),
    otherThreadFiles: join(TASK_WORKSPACES_DIR, f.target.id), configuredProjectFolder: "/tmp/mission-project",
    tasks: expect.arrayContaining([{ threadId: task.threadId, workingFolder: "/tmp/mission-task" }]),
  } });
});

it("omits guest-private tasks and the parent root that would expose them", async () => {
  const f = fixture();
  const guest = f.store.createTask(f.target.id, "Guest task", false)!;
  f.store.patchTask(f.target.id, guest.threadId, { cwd: join(TASK_WORKSPACES_DIR, f.target.id, guest.threadId) });
  f.privateThreads.add(guest.threadId);
  const result = await f.call({ targetBotId: f.target.id });
  expect(result.status).toBe(200);
  expect(result.body).not.toHaveProperty("otherThreadFiles");
  expect(JSON.stringify(result.body)).not.toContain(guest.threadId);
  f.privateThreads.add(f.master.threadId);
  expect(await f.call({ targetBotId: f.target.id })).toMatchObject({ status: 403 });
});

it("rechecks Master assignment, hidden bots and audience before revealing paths", async () => {
  const f = fixture();
  expect(await f.call({ targetBotId: f.target.id }, f.target)).toMatchObject({ status: 403 });
  f.store.patchBot(f.target.id, { hidden: true });
  expect(await f.call({ targetBotId: f.target.id })).toMatchObject({ status: 403 });
  f.store.patchBot(f.target.id, { hidden: false, visibility: "admins" });
  expect(await f.call({ targetBotId: f.target.id })).toMatchObject({ status: 403 });
  f.store.patchBot(f.target.id, { visibility: "everyone" });
  saveConfig({ masterChiefOfStaffBotId: null, masterChiefOfStaffRevision: "revoked" });
  expect(await f.call({ targetBotId: f.target.id })).toMatchObject({ status: 403 });
  f.store.setChiefOfStaff(f.target.id);
  saveConfig({ masterChiefOfStaffBotId: f.target.id, masterChiefOfStaffRevision: "transferred" });
  expect(await f.call({ targetBotId: f.target.id })).toMatchObject({ status: 403 });
  expect(await f.call({ targetBotId: f.master.id }, f.target)).toMatchObject({ status: 200 });
  expect(await f.call({ targetBotId: f.target.id }, f.target)).toMatchObject({ status: 200 });
});

it.each([{}, { targetBotId: "" }, { targetBotId: "missing" }, { targetBotId: "../../private" }, { targetBotId: "unused", path: "/etc" }])("rejects missing, unknown or path-shaped requests %j", async body => {
  const f = fixture();
  expect((await f.call(body)).status).toBeGreaterThanOrEqual(400);
});
