import { rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it } from "vitest";

import type { WireBot } from "../../shared/wire.ts";
import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import type { RequestAuth } from "../request-auth.ts";
import { Store, type BotRecord } from "../store.ts";
import { createApprovalGrantRoutes, type ApprovalGrantRouteDeps } from "./approval-grants.ts";
import { PASS, type RouteContext } from "./table.ts";

const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

function fixture(operatorFullAccess: boolean) {
  const store = new Store(() => sonnet);
  const bot = store.createBot({ name: "Scout" });
  store.patchBot(bot.id, { alwaysAllow: ["Bash"] });
  store.patchTask(bot.id, bot.threadId, { alwaysAllow: ["Bash", "mcp:mail:send_email"] });
  const live = { ...store.bot(bot.id)!, alwaysAllow: ["Bash"] } as BotRecord;
  const deps = {
    store,
    hostedFullAccessRefusal: null,
    cloudHome: false,
    desktopManaged: false,
    operatorFullAccess,
    pendingApprovalChanges: new Map(),
    applyPendingApprovalChanges: () => {},
    directTurnBots: new Set([live]),
    cloudOwnerSession: () => true,
    canManageCommandAllowlist: () => true,
    supportsApprovalMode: () => true,
    threadBusy: () => false,
    interruptDirectThread: async () => {},
    usageTriggerFor: () => "person",
    answerRequest: async () => "unavailable",
    broadcast: () => {},
    wireBot: (record: BotRecord) => record as unknown as WireBot,
  } as unknown as ApprovalGrantRouteDeps;
  const handler = createApprovalGrantRoutes(deps);
  const allowEverything = async (body: Record<string, unknown>) => {
    const sent: Array<{ status: number; body: any }> = [];
    const out = await handler({
      req: { headers: { origin: "http://localhost" } } as unknown as IncomingMessage,
      res: {} as ServerResponse,
      url: new URL(`http://localhost/api/bots/${bot.id}/allow-everything`),
      path: `/api/bots/${bot.id}/allow-everything`,
      method: "POST",
      auth: { kind: "loopback", scopes: ["admin"] } as RequestAuth,
      json: ((_res: ServerResponse, status: number, response: unknown) => { sent.push({ status, body: response }); }) as RouteContext["json"],
      readBody: (async () => body) as RouteContext["readBody"],
    });
    expect(out).not.toBe(PASS);
    return sent[0]!;
  };
  return { store, bot, live, allowEverything };
}

describe("POST /api/bots/:id/allow-everything", () => {
  it("refuses Full access over HTTP without the operator's opt-in", async () => {
    const { store, bot, allowEverything } = fixture(false);
    expect((await allowEverything({ threadId: bot.threadId, confirmFullAccess: true })).status).toBe(403);
    expect(store.taskByThread(bot.id, bot.threadId)?.approvalMode).not.toBe("full");
  });

  it("refuses the operator's grant until the warning is acknowledged", async () => {
    const { store, bot, allowEverything } = fixture(true);
    const refused = await allowEverything({ threadId: bot.threadId });
    expect(refused).toMatchObject({ status: 400, body: { error: "Confirm the Full access warning first (confirmFullAccess)" } });
    expect(store.taskByThread(bot.id, bot.threadId)?.alwaysAllow).toEqual(["Bash", "mcp:mail:send_email"]);
  });

  it("clears saved always-allow approvals, so returning to Ask does not bring them back", async () => {
    const { store, bot, live, allowEverything } = fixture(true);
    expect((await allowEverything({ threadId: bot.threadId, confirmFullAccess: true })).status).toBe(200);
    expect(store.taskByThread(bot.id, bot.threadId)).toMatchObject({ approvalMode: "full", alwaysAllow: [] });
    expect(store.bot(bot.id)?.alwaysAllow ?? []).toEqual([]);
    expect(live.alwaysAllow).toEqual([]);

    store.patchTask(bot.id, bot.threadId, { approvalMode: "ask", autoApprove: false });
    expect(store.taskByThread(bot.id, bot.threadId)?.alwaysAllow ?? []).toEqual([]);
  });

});
