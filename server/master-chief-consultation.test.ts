import { afterEach, describe, expect, it } from "vitest";
import { saveConfig } from "./config.ts";
import { canAccessTeam, canConsultMaster, canReachPeer, resolveTeammate } from "./peer-roster.ts";

describe("Master Chief consultation scope", () => {
  const sender = { id: "paul", name: "St. Paul", section: "Mission" };
  const master = { id: "egg", name: "Dr. EggBot", section: "Leadership", chiefOfStaff: true };
  afterEach(() => saveConfig({ masterChiefOfStaffBotId: null, masterChiefOfStaffRevision: "cleared" }));

  it("permits consultation without granting team management or legacy messaging", () => {
    saveConfig({ masterChiefOfStaffBotId: master.id, masterChiefOfStaffRevision: "assigned" });
    expect(canConsultMaster(sender, master)).toBe(true);
    expect(canReachPeer(sender, master)).toBe(false);
    expect(canAccessTeam(sender, master.section)).toBe(false);
    expect(resolveTeammate([sender, master], sender, "Dr. EggBot")).toHaveProperty("error");
    expect(resolveTeammate([sender, master], sender, "@dr. eggbot", [], canConsultMaster)).toEqual({ id: master.id, byName: true });
  });

  it("honors explicit peers and audiences, and refuses hidden, self and ordinary targets", () => {
    saveConfig({ masterChiefOfStaffBotId: master.id, masterChiefOfStaffRevision: "assigned" });
    expect(canConsultMaster({ ...sender, peers: [] }, master)).toBe(false);
    expect(canConsultMaster({ ...sender, peers: [master.id] }, master)).toBe(true);
    expect(canConsultMaster(sender, { ...master, visibility: "admins" })).toBe(false);
    expect(canConsultMaster({ ...sender, visibility: "admins" }, { ...master, visibility: "admins" })).toBe(true);
    expect(canConsultMaster(sender, { ...master, hidden: true })).toBe(false);
    expect(canConsultMaster({ ...sender, hidden: true }, master)).toBe(false);
    expect(canConsultMaster(master, master)).toBe(false);
    expect(canConsultMaster(sender, { ...master, chiefOfStaff: false })).toBe(false);
    expect(canConsultMaster(sender, { ...master, id: "other" })).toBe(false);
  });

  it("rechecks assignment revocation and transfer", () => {
    saveConfig({ masterChiefOfStaffBotId: master.id, masterChiefOfStaffRevision: "assigned" });
    expect(canConsultMaster(sender, master)).toBe(true);
    saveConfig({ masterChiefOfStaffBotId: "successor", masterChiefOfStaffRevision: "transferred" });
    expect(canConsultMaster(sender, master)).toBe(false);
    expect(canConsultMaster(sender, { ...master, id: "successor" })).toBe(true);
    saveConfig({ masterChiefOfStaffBotId: null, masterChiefOfStaffRevision: "revoked" });
    expect(canConsultMaster(sender, { ...master, id: "successor" })).toBe(false);
  });
});
