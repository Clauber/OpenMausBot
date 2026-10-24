import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { PERSONAL_SPACE_ID, SpaceRegistry, setActiveSpaces } from "./space-scope.ts";
import { DATA_DIR, saveConfig } from "./config.ts";
import { Store } from "./store.ts";
import { fleetRoomAuthorized } from "./fleet-rooms.ts";
import { readFleetAudit } from "./fleet-audit.ts";

describe("master-authorized room tasks", () => {
  beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
  afterEach(() => setActiveSpaces(undefined));
  const selection = () => ({ instanceId: "claude", model: "test" });
  function fixture() {
    const store = new Store(selection);
    const master = store.createBot({ name: "Master", section: "Support" });
    store.setChiefOfStaff(master.id);
    saveConfig({ masterChiefOfStaffBotId: master.id, masterChiefOfStaffRevision: "one" });
    const pam = store.createBot({ name: "Pam" });
    const watcher = store.createBot({ name: "Watcher", section: "Support" });
    const room = store.createGroup("Work", [pam.id, watcher.id], false, undefined, { bulletin: "Work", defaultResponder: { kind: "everyone" }, completed: true });
    const task = store.createFleetRoomTask(master.id, room.id, "Fleet work");
    return { store, master, pam, watcher, room, task };
  }

  it("rejects a room task across unlinked spaces without changing the room", () => {
    const f = fixture();
    const spaces = new SpaceRegistry(join(DATA_DIR, "spaces.json"));
    setActiveSpaces(spaces);
    const other = spaces.create("Other");
    spaces.assign("bot", f.pam.id, other.id);
    const before = { threadId: f.room.threadId, tasks: f.room.tasks?.length };
    expect(() => f.store.createFleetRoomTask(f.master.id, f.room.id, "Cross-space")).toThrow(/space/i);
    expect({ threadId: f.room.threadId, tasks: f.room.tasks?.length }).toEqual(before);
    expect(fleetRoomAuthorized(f.store, f.room, f.task.threadId)).toBe(false);
  });

  it("invalidates a grant when only the issuer moves to an unlinked space", () => {
    const f = fixture();
    const spaces = new SpaceRegistry(join(DATA_DIR, "spaces.json"));
    setActiveSpaces(spaces);
    const other = spaces.create("Master only");
    spaces.assign("bot", f.master.id, other.id);
    expect(fleetRoomAuthorized(f.store, f.room, f.task.threadId)).toBe(false);
    expect(() => f.store.createFleetRoomTask(f.master.id, f.room.id, "Unreachable")).toThrow(/space/i);
    spaces.allowDelegation(other.id, PERSONAL_SPACE_ID);
    expect(fleetRoomAuthorized(f.store, f.room, f.task.threadId)).toBe(true);
  });

  it("requires directed space grants for the issuer and every room member", () => {
    const f = fixture();
    const spaces = new SpaceRegistry(join(DATA_DIR, "spaces.json"));
    setActiveSpaces(spaces);
    const other = spaces.create("Other");
    spaces.assign("bot", f.pam.id, other.id);
    spaces.allowDelegation(PERSONAL_SPACE_ID, other.id);
    expect(fleetRoomAuthorized(f.store, f.room, f.task.threadId)).toBe(false);
    expect(() => f.store.createFleetRoomTask(f.master.id, f.room.id, "One way")).toThrow(/space/i);
    spaces.allowDelegation(other.id, PERSONAL_SPACE_ID);
    expect(fleetRoomAuthorized(f.store, f.room, f.task.threadId)).toBe(true);
    const task = f.store.createFleetRoomTask(f.master.id, f.room.id, "Linked");
    expect(fleetRoomAuthorized(f.store, f.room, task.threadId)).toBe(true);
    spaces.revokeDelegation(other.id, PERSONAL_SPACE_ID);
    expect(fleetRoomAuthorized(f.store, f.room, task.threadId)).toBe(false);
  });

  it("authorizes only the granted task and survives reload", () => {
    const f = fixture();
    expect(fleetRoomAuthorized(f.store, f.room, f.task.threadId)).toBe(true);
    const unrelated = f.store.createGroupTask(f.room.id, "Unrelated", false)!;
    expect(fleetRoomAuthorized(f.store, f.room, unrelated.threadId)).toBe(false);
    const loaded = new Store(selection);
    expect(fleetRoomAuthorized(loaded, loaded.group(f.room.id)!, f.task.threadId)).toBe(true);
  });

  it("never revives a grant after member add/remove or assignment away/back", () => {
    const f = fixture();
    saveConfig({ masterChiefOfStaffBotId: f.master.id, masterChiefOfStaffRevision: "new-assignment" });
    expect(fleetRoomAuthorized(f.store, f.room, f.task.threadId)).toBe(false);
    const fresh = f.store.createFleetRoomTask(f.master.id, f.room.id, "Fresh");
    expect(fleetRoomAuthorized(f.store, f.room, fresh.threadId)).toBe(true);
    f.store.patchGroup(f.room.id, { memberIds: [...f.room.memberIds, f.master.id] });
    f.store.patchGroup(f.room.id, { memberIds: [f.pam.id, f.watcher.id] });
    expect(fleetRoomAuthorized(f.store, f.room, fresh.threadId)).toBe(false);
    expect(readFleetAudit().some(row => row.reason === "room-grant-revocation" && row.status === "applied")).toBe(true);
  });

  it("rejects an audience conflict and protects the holder from demotion/deletion", () => {
    const f = fixture();
    f.store.patchBot(f.watcher.id, { visibility: "admins" });
    expect(() => f.store.createFleetRoomTask(f.master.id, f.room.id, "Private")).toThrow(/audience|visible/i);
    expect(fleetRoomAuthorized(f.store, f.room, f.task.threadId)).toBe(false);
    expect(() => f.store.patchBot(f.master.id, { chiefOfStaff: false })).toThrow(/Master Chief/);
    expect(() => f.store.setChiefOfStaff(f.watcher.id)).toThrow(/Master Chief/);
    expect(() => f.store.deleteBot(f.master.id)).toThrow(/Master Chief/);
  });

  it("refuses a room whose members all share an audience the master is outside", () => {
    const f = fixture();
    f.store.patchBot(f.pam.id, { visibility: "admins" });
    f.store.patchBot(f.watcher.id, { visibility: "admins" });
    const before = { threadId: f.store.group(f.room.id)!.threadId, tasks: f.store.group(f.room.id)!.tasks?.length };
    expect(() => f.store.createFleetRoomTask(f.master.id, f.room.id, "Admins only")).toThrow(/visible/i);
    expect({ threadId: f.store.group(f.room.id)!.threadId, tasks: f.store.group(f.room.id)!.tasks?.length }).toEqual(before);
    expect(fleetRoomAuthorized(f.store, f.room, f.task.threadId)).toBe(false);
  });
});
