import type { TaughtComputer, TeachingSessions } from "../teaching-session.ts";
import { taughtSummary } from "../teaching-session.ts";
import { PASS, type RouteHandler } from "./table.ts";

/** Internal path the computer proxy calls around each tool call it makes while a demo is recorded. */
export const TEACH_CAPTURE_PATH = "/api/internal/teach-capture";

const TEACH_PATH = /^\/api\/bots\/([^/]+)\/tasks\/([^/]+)\/teach(?:\/(start|stop|discard|action|replay|settings))?$/;

export interface TeachRouteDeps {
  teaching: TeachingSessions;
  projectBotForTask(botId: string, threadId: string): unknown;
  taskByThread(botId: string, threadId: string): unknown;
  openTaughtComputer(botId: string, threadId: string): Promise<TaughtComputer>;
  skillProposalPersistence(botId: string, threadId: string): { ok: true } | { ok: false; status: number; error: string };
  isSkillEnabled(botId: string, name: unknown): boolean;
  hasSkill(botId: string, name: string): boolean;
  stageSkillWrite(botId: string, input: any): any;
  rejectStagedSkillWrite(botId: string, id: string): void;
  appendSkillRequestCard(args: { botId: string; threadId: string; staged: any }): any;
  startTaughtReplay(runId: string): void;
  redactSecretsInText(text: string): string;
}

/** Taught-skill demos on a bot conversation: record, act, replay (replay stages an approval card). */
export function createTeachRoutes(deps: TeachRouteDeps): RouteHandler {
  const { teaching } = deps;
  return async ({ req, res, path, method, json, readBody }) => {
    const m = path.match(TEACH_PATH);
    if (!m) return PASS;
    const [botId, threadId, operation] = m.slice(1) as [string, string, string | undefined];
    const bot = deps.projectBotForTask(botId, threadId);
    if (!bot || !deps.taskByThread(botId, threadId)) return json(res, 404, { error: "Unknown bot conversation." });
    if (method === "GET" && !operation) return json(res, 200, { session: teaching.current(botId, threadId) ?? null, playbooks: teaching.list(botId), alwaysAsk: teaching.alwaysAsk(botId) });
    if (method !== "POST" || !operation) return json(res, 405, { error: "Unknown teaching operation." });
    const body = await readBody(req);
    try {
      if (operation === "settings") {
        if (typeof body.alwaysAsk !== "boolean") return json(res, 400, { error: "alwaysAsk must be boolean" });
        teaching.setAlwaysAsk(botId, body.alwaysAsk); return json(res, 200, { alwaysAsk: body.alwaysAsk });
      }
      if (operation === "discard") { teaching.discard(botId, threadId); return json(res, 200, { ok: true }); }
      if (operation === "stop") return json(res, 201, { playbook: teaching.stop(botId, threadId) });
      const computer = await deps.openTaughtComputer(botId, threadId);
      try {
        if (operation === "start") return json(res, 201, { session: teaching.start(botId, threadId, computer, String(body.title ?? ""), String(body.notes ?? "")) });
        if (operation === "action") {
          if (!teaching.current(botId, threadId)) throw new Error("Start recording before demonstrating actions.");
          if (!body.args || typeof body.args !== "object" || Array.isArray(body.args)) throw new Error("Action args must be an object.");
          return json(res, 200, { result: await teaching.perform(botId, threadId, computer, body.tool, body.args) });
        }
        if (operation === "replay") {
          const persistence = deps.skillProposalPersistence(botId, threadId);
          if (!persistence.ok) return json(res, persistence.status, { error: persistence.error });
          if (!deps.isSkillEnabled(botId, body.name)) teaching.revoke(botId, String(body.name ?? ""));
          const run = teaching.request(String(body.name ?? ""), botId, threadId, computer, body.compareScreenshots === true);
          if (run.status === "awaiting-approval") {
            const source = `learn:taught:${run.id}`;
            const summary = taughtSummary(teaching.read(run.name)) + `\nReplay request: ${run.id}\n`;
            const staged = deps.stageSkillWrite(botId, { action: deps.hasSkill(botId, run.name) ? "update" : "create",
              targetName: run.name, files: [{ path: "SKILL.md", content: summary }], source, gist: `Replay ${run.name} on ${computer.kind}. Review every recorded argument.` });
            if ("error" in staged) { teaching.reject(run.id, staged.error); throw new Error(staged.error); }
            teaching.staged(run, staged.id);
            try { const card = deps.appendSkillRequestCard({ botId, threadId, staged }); return json(res, 202, { run, ...card }); }
            catch (error) { deps.rejectStagedSkillWrite(botId, staged.id); teaching.reject(run.id, String(error)); throw error; }
          }
          deps.startTaughtReplay(run.id); return json(res, 202, { run });
        }
        return json(res, 404, { error: "Unknown teaching operation." });
      } finally { await computer.close(); }
    } catch (error) { return json(res, 409, { error: deps.redactSecretsInText(error instanceof Error ? error.message : String(error)) }); }
  };
}

export interface TeachCaptureDeps<C extends { botId: string; threadId: string }> {
  teaching: TeachingSessions;
  /** The computer the turn is driving, in the id form a playbook records. */
  computerId(capability: C): string;
}

/** The recorded half of a tool call: "begin" opens a capture, anything else finishes it with the result.
 * The caller has already authorized the turn's capability. */
export function createTeachCapture<C extends { botId: string; threadId: string }>(deps: TeachCaptureDeps<C>, randomId: () => string) {
  const captures = new Map<string, { botId: string; threadId: string; finish: (result: unknown) => void }>();
  return (capability: C, body: any): { captureId?: string } | { ok: true } => {
    const { botId, threadId } = capability;
    if (body.phase === "begin") {
      const finish = deps.teaching.begin(botId, threadId, deps.computerId(capability), body.tool, body.args ?? {});
      const captureId = finish ? randomId() : undefined;
      if (captureId && finish) captures.set(captureId, { botId, threadId, finish });
      return { captureId };
    }
    const capture = captures.get(body.captureId);
    if (capture && capture.botId === botId && capture.threadId === threadId) {
      captures.delete(body.captureId); capture.finish(body.result);
    }
    return { ok: true };
  };
}
