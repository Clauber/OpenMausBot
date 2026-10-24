import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as atomic from "./atomic.ts";
import { Store } from "./store.ts";
import { DATA_DIR, ensureDirs } from "./config.ts";
import { auditedWrite, fleetAuditScope, prepareFleetDispatch, readFleetAudit, withoutFleetActor } from "./fleet-audit.ts";

describe("durable fleet receipts", () => {
  beforeEach(() => { rmSync(DATA_DIR, { recursive: true, force: true }); ensureDirs(); });
  it("records persisted before/after values and preserves a deleted target's identity", () => {
    ensureDirs();
    const file = join(DATA_DIR, "audit-fixture.json");
    writeFileSync(file, JSON.stringify([{ id: "pam", name: "Pam", soul: "old" }]));
    fleetAuditScope.run({ botId: "master", threadId: "thread", authorize() {} }, () => {
      auditedWrite(file, JSON.stringify([{ id: "pam", name: "Pam", soul: "new" }]), "bots");
      auditedWrite(file, "[]", "bots");
    });
    const rows = readFleetAudit();
    expect(rows.slice(-2).map(row => row.status)).toEqual(["applied", "applied"]);
    expect(rows.at(-1)?.changes).toContainEqual(expect.objectContaining({ targetId: "pam", name: "Pam", after: null }));
    expect(readFileSync(file, "utf8")).toBe("[]");
  });

  it("records startup revocation for both thread-only and bot-wide pending grants", () => {
    const select = () => ({ instanceId: "claude", model: "test" });
    const store = new Store(select);
    const bot = store.createBot({ name: "Pending grant" });
    store.patchBot(bot.id, { approvalMode: "full", approvalGrant: { requestId: "pending", mode: "full", phase: "prepared" } });
    expect(new Store(select).bot(bot.id)?.approvalMode).toBe("ask");
    expect(readFleetAudit().at(-1)).toMatchObject({ reason: "reload", status: "applied" });
    store.patchBot(bot.id, { approvalMode: "ask", approvalGrant: { requestId: "thread", mode: "full", phase: "prepared", threadId: bot.threadId, threadOnly: true } });
    store.patchTask(bot.id, bot.threadId, { approvalMode: "full" });
    const loaded = new Store(select);
    expect(loaded.taskByThread(bot.id, bot.threadId)?.approvalMode).toBe("ask");
    expect(readFleetAudit().at(-1)?.changes[0]?.after?.approvalMode).toBe("ask");
  });

  it("preserves a runtime-only tightening after a failed bot save and records the failure", () => {
    const store = new Store(() => ({ instanceId: "claude", model: "test" }));
    const bot = store.createBot();
    store.patchTask(bot.id, bot.threadId, { approvalMode: "full" });
    const file = join(DATA_DIR, "bots.json"), backup = file + ".saved";
    renameSync(file, backup); mkdirSync(file);
    try {
      expect(() => store.patchTask(bot.id, bot.threadId, { approvalMode: "ask" })).toThrow();
      expect(store.taskByThread(bot.id, bot.threadId)?.approvalMode).toBe("ask");
      expect(readFleetAudit().at(-1)).toMatchObject({ reason: "save-failed", status: "runtime-only" });
    } finally { rmSync(file, { recursive: true }); renameSync(backup, file); }
    const runtime = readFleetAudit().at(-1)!;
    store.patchBot(bot.id, { title: "Persist retained restriction" });
    expect(readFleetAudit().some(row => row.reason === "reconciliation" && row.reconciles === runtime.id && row.status === "applied")).toBe(true);
    expect(new Store(() => ({ instanceId: "claude", model: "test" })).taskByThread(bot.id, bot.threadId)?.approvalMode).toBe("ask");
  });

  it("rolls back grant activation when audit persistence fails", () => {
    const store = new Store(() => ({ instanceId: "claude", model: "test" }));
    const bot = store.createBot();
    store.patchBot(bot.id, { approvalMode: "full", approvalGrant: { requestId: "pending", mode: "full", phase: "committed" } });
    mkdirSync(join(DATA_DIR, "fleet-audit.json"));
    expect(() => fleetAuditScope.run({ botId: "master", threadId: "request", authorize() {} }, () =>
      store.patchBot(bot.id, { approvalGrant: undefined }))).toThrow();
    expect(store.bot(bot.id)?.approvalGrant?.requestId).toBe("pending");
  });

  it("rolls back a thread-only grant activation on another thread when audit persistence fails", () => {
    const store = new Store(() => ({ instanceId: "claude", model: "test" }));
    const bot = store.createBot();
    store.patchBot(bot.id, { approvalMode: "full" });
    const other = store.createTask(bot.id, "Other", false)!;
    store.patchBot(bot.id, { approvalGrant: { requestId: "thread-grant", mode: "full", phase: "committed", threadId: other.threadId, threadOnly: true } });
    expect(store.bot(bot.id)!.threadId).not.toBe(other.threadId);
    mkdirSync(join(DATA_DIR, "fleet-audit.json"));
    expect(() => fleetAuditScope.run({ botId: "master", threadId: "request", authorize() {} }, () =>
      store.patchBot(bot.id, { approvalGrant: undefined }))).toThrow();
    expect(store.bot(bot.id)?.approvalGrant?.requestId).toBe("thread-grant");
  });

  it("refuses an expired actor's continuation before mutation, while a detached turn writes unattributed", () => {
    const file = join(DATA_DIR, "audit-fixture.json");
    writeFileSync(file, "[]");
    const expired = { botId: "master", threadId: "ended-turn", authorize() { throw new Error("the internal turn capability has expired"); } };
    expect(() => fleetAuditScope.run(expired, () => auditedWrite(file, JSON.stringify([{ id: "pam", soul: "late" }]), "bots"))).toThrow(/expired/);
    expect(readFileSync(file, "utf8")).toBe("[]");
    fleetAuditScope.run(expired, () => withoutFleetActor(() => auditedWrite(file, JSON.stringify([{ id: "pam", soul: "own turn" }]), "bots")));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([{ id: "pam", soul: "own turn" }]);
    expect(readFleetAudit().some(row => row.actorBotId === "master")).toBe(false);
  });

  it("fails before mutation when its durable audit cannot be written", () => {
    const file = join(DATA_DIR, "audit-fixture.json");
    writeFileSync(file, "[]"); mkdirSync(join(DATA_DIR, "fleet-audit.json"));
    expect(() => fleetAuditScope.run({ botId: "master", threadId: "thread", authorize() {} }, () => auditedWrite(file, JSON.stringify([{ id: "pam", soul: "new" }]), "bots"))).toThrow();
    expect(readFileSync(file, "utf8")).toBe("[]");
  });

  it("recovers a prepared receipt when finalization fails after the data committed", () => {
    const file = join(DATA_DIR, "audit-fixture.json");
    writeFileSync(file, "[]");
    const write = atomic.writeFileAtomic;
    let auditWrites = 0;
    const spy = vi.spyOn(atomic, "writeFileAtomic").mockImplementation((path, value, options) => {
      if (path === join(DATA_DIR, "fleet-audit.json") && ++auditWrites === 2) throw new Error("finalization failed");
      write(path, value, options);
    });
    try {
      expect(() => fleetAuditScope.run({ botId: "master", threadId: "thread", authorize() {} }, () =>
        auditedWrite(file, JSON.stringify([{ id: "pam", approvalMode: "full" }]), "bots"))).not.toThrow();
    } finally { spy.mockRestore(); }
    expect(JSON.parse(readFileSync(file, "utf8"))[0].approvalMode).toBe("full");
    expect(JSON.parse(readFileSync(join(DATA_DIR, "fleet-audit.json"), "utf8"))[0].status).toBe("prepared");
    expect(readFleetAudit()[0]?.status).toBe("applied");
  });

  it("retains an unanswered card but resets runtime busy across reload", () => {
    const select = () => ({ instanceId: "claude", model: "test" });
    const store = new Store(select), bot = store.createBot();
    store.appendMessage(bot.threadId, { role: "bot", kind: "options", card: { title: "Approval", subtitle: "Fixture permission", options: ["Allow", "Deny"], requestId: "held", requestType: "permission" } });
    store.setTaskActivity(bot.id, bot.threadId, "waiting-on-you");
    expect(store.taskByThread(bot.id, bot.threadId)?.busy).toBe(true);
    store.patchBot(bot.id, { title: "Persist without replay" });
    const loaded = new Store(select);
    expect(loaded.taskByThread(bot.id, bot.threadId)?.busy).toBe(false);
    expect(loaded.messagesFor(bot.threadId).some(message => message.card?.requestId === "held" && !message.card.answered)).toBe(true);
  });

  it("refuses a revoked request before writing anything", () => {
    const file = join(DATA_DIR, "audit-fixture.json");
    writeFileSync(file, "[]");
    const before = readFileSync(file, "utf8");
    expect(() => fleetAuditScope.run({ botId: "old-master", threadId: "old", authorize() { throw new Error("revoked"); } }, () =>
      auditedWrite(file, "forged", "bots"))).toThrow("revoked");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("audits dispatch participants without message content and deduplicates coordinator retries", () => {
    fleetAuditScope.run({ botId: "master", threadId: "source", authorize() {} }, () => {
      prepareFleetDispatch("pam", "Pam", "target", "room")("handoff");
      prepareFleetDispatch("pam", "Pam", "target", "room")("handoff", true);
    });
    const rows = readFleetAudit().filter(row => row.scope === "communication");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorBotId: "master", threadId: "source", status: "applied", changes: [{ targetId: "pam", after: { threadId: "target", roomId: "room", requestId: "handoff" } }] });
  });
});
