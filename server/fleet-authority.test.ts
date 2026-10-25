import { describe, expect, it } from "vitest";
import { parseConfigPatch, saveConfig } from "./config.ts";
import { isMasterChief, masterAssignment } from "./fleet-authority.ts";
import { canAccessTeam, canReachPeer, peerAllowed } from "./peer-roster.ts";

describe("owner-selected fleet authority", () => {
  const master = { id: "master", name: "Master", chiefOfStaff: true, section: "Support", peers: [] };
  const general = { id: "general", name: "General" };

  it("reaches General and other Chiefs without changing their permissions or peer lists", () => {
    saveConfig({ masterChiefOfStaffBotId: master.id, masterChiefOfStaffRevision: "first" });
    expect(isMasterChief(master)).toBe(true);
    expect(canAccessTeam(master, undefined)).toBe(true);
    expect(canReachPeer(master, general)).toBe(true);
    expect(canReachPeer(master, { ...general, section: "Unknown", chiefOfStaff: true })).toBe(true);
    expect(peerAllowed(master, general)).toBe(true);
    expect(master.peers).toEqual([]);
    expect(canReachPeer(general, master)).toBe(false);
    expect(canReachPeer(master, { ...general, hidden: true })).toBe(false);
    expect(canReachPeer(master, { ...general, visibility: "admins" })).toBe(false);
  });

  it("uses the current singleton assignment and requires a visible Chief", () => {
    saveConfig({ masterChiefOfStaffBotId: master.id, masterChiefOfStaffRevision: "second" });
    expect(isMasterChief({ ...master, chiefOfStaff: false })).toBe(false);
    expect(isMasterChief({ ...master, hidden: true })).toBe(false);
    saveConfig({ masterChiefOfStaffBotId: general.id, masterChiefOfStaffRevision: "third" });
    expect(isMasterChief(master)).toBe(false);
    expect(canReachPeer(master, general)).toBe(false);
    expect(masterAssignment()).toEqual({ botId: general.id, revision: "third" });
    saveConfig({ masterChiefOfStaffBotId: null, masterChiefOfStaffRevision: "revoked" });
    expect(masterAssignment().botId).toBeNull();
  });

  it("rejects assignment through the ordinary config patch", () => {
    expect(() => parseConfigPatch({ masterChiefOfStaffBotId: master.id })).toThrow();
    expect(() => parseConfigPatch({ masterChiefOfStaffRevision: "forged" })).toThrow();
  });
});
