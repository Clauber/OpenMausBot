// One ZCode turn on its own `zcode app-server` child, spoken in ZCode Protocol
// v4 through @clauber/zcode-adapter. The child lives for this turn only:
// connect, open or resume the session, send, follow the conversation
// projection until the turn ends, then close the child and its process group.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import {
  connect,
  InteractionNotPendingError,
  turnForCommand,
  type ConversationState,
  type InputMode,
  type McpServer,
  type PendingInteraction,
  type Row,
  type Session,
  type SessionEvent,
  type SessionId,
} from "@clauber/zcode-adapter";
import { applySessionConfig, loadZCodeMcpServers } from "@clauber/zcode-adapter/config";

import type { RuntimeEvent, RuntimeEventBase } from "../contracts.ts";
import { assertSafeCliArgv, resolveCli } from "../procs.ts";
import { commandSummary, toolDetailPreview } from "../tool-summary.ts";
import { announcesAction, CONTINUATION_NUDGE } from "./announced-action.ts";
import { appendNative } from "./native.ts";
import { classifyError } from "./retry.ts";
import {
  isTransientZcodeFailure,
  zcodeFailureReason,
  zcodeResumeDelayMs,
  ZCODE_MAX_TURN_RESUMES,
  ZCODE_RESUME_PROMPT,
} from "./zcode-turn-recovery.ts";

export const DENY_TIMEOUT_NOTE =
  "Legion: nobody answered this permission request in time. Skip this action and finish what you can without it.";
const ASK_TIMEOUT_MS = 15 * 60_000;
const CLOSE_GRACE_MS = 5_000;
const STOP_ACK_MS = 3_000;
/** 0.16.9 settles a stopped turn about 150 ms after the stop ACK (measured). */
const STOP_GRACE_MS = 3_000;

export type ZcodeAskBehavior = "allow" | "deny" | "answer";
export type ZcodeAskSource = "user" | "timeout" | "system";
export type ZcodeAsk = (behavior: ZcodeAskBehavior, message?: string, source?: ZcodeAskSource) => void;
type Usage = { input: number; output: number; cachedInput: number };

/** A zcode permission request's input is usually the tool arguments object
 * (Bash carries `command`). Only a plain string command becomes the card's
 * exact-command line — anything else falls back to the reason text. */
export function zcodeRequestSummary(params: { toolName?: unknown; reason?: unknown; input?: unknown }): {
  tool: string;
  summary: string;
  command?: { command: string; cwd: string };
} {
  const tool = typeof params.toolName === "string" && params.toolName ? params.toolName : "tool";
  const input = params.input && typeof params.input === "object" && !Array.isArray(params.input)
    ? params.input as Record<string, unknown>
    : null;
  const rawCommand = input?.command;
  const command = typeof rawCommand === "string" && rawCommand.trim() ? rawCommand.trim() : null;
  const rawCwd = input?.cwd;
  const inputCwd = typeof rawCwd === "string" ? rawCwd : "";
  const reason = typeof params.reason === "string" && params.reason.trim() ? params.reason.trim() : "";
  return {
    tool,
    summary: (command ? commandSummary({ command }) : undefined) ?? (reason || tool),
    ...(command ? { command: { command, cwd: inputCwd } } : {}),
  };
}

type Card = Pick<Extract<RuntimeEvent, { type: "request.opened" }>, "requestType" | "tool" | "summary" | "command" | "choices">;

function cardFor(interaction: Exclude<PendingInteraction, { kind: "unknown" }>): Card {
  if (interaction.kind === "question") {
    const first = interaction.questions[0];
    const choices = first?.options.map((option) => option.label) ?? [];
    return { requestType: "question", tool: "ask_user", summary: first?.question || interaction.prompt, ...(choices.length ? { choices } : {}) };
  }
  if (interaction.kind === "planApproval") return { requestType: "permission", tool: "ExitPlanMode", summary: interaction.plan || "Approve the plan" };
  const { tool, summary, command } = zcodeRequestSummary({ toolName: interaction.toolName, reason: interaction.summary, input: interaction.detail });
  return { requestType: "permission", tool, summary, ...(command?.cwd ? { command } : {}) };
}

export interface ZcodeStdioTurnInput {
  cli: string;
  cwd: string;
  env: Record<string, string | undefined>;
  threadId: string;
  /** The conversation's `sess_` id; null starts a new session. */
  resumeSessionId: string | null;
  /** The harness's own servers. They win by name over the ZCode config files' servers. */
  harnessMcpServers: McpServer[];
  /** Whether the bot's tool scope lets it use a config-file server. */
  allowMcpServer: (name: string) => boolean;
  mode: InputMode;
  /** Full access: answer a permission ask with allow-once where ZCode offers it. */
  autoAllow: boolean;
  model: { provider: string; model: string; thought?: string } | null;
  text: string;
  images: ReadonlyArray<{ path: string; mime: string }>;
  retryScale: number;
}

export interface ZcodeStdioTurnSink {
  base(): RuntimeEventBase;
  emit(event: RuntimeEvent): void;
  /** Called once, after the child is gone. */
  finish(ok: boolean, stopReason: string | null, usage: Usage | undefined): void;
}

export interface ZcodeStdioTurnHandle {
  stop(): Promise<boolean>;
  asks: Map<string, ZcodeAsk>;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function startZcodeStdioTurn(turn: ZcodeStdioTurnInput, sink: ZcodeStdioTurnSink): ZcodeStdioTurnHandle {
  const resolved = resolveCli(turn.cli, ["app-server", "--cwd", turn.cwd], turn.env);
  assertSafeCliArgv(resolved);
  const conn = connect({ cwd: turn.cwd, command: resolved.command, args: resolved.args, env: turn.env, clientId: "openmausbot" });
  conn.wire.onNotification((notification) => {
    if (notification.method !== "v4/telemetry/event") appendNative(turn.threadId, { dir: "in", source: "zcode.app-server", msg: notification });
  });

  const emit = (event: Record<string, unknown> & { type: RuntimeEvent["type"] }) => sink.emit({ ...sink.base(), ...event } as RuntimeEvent);
  const asks = new Map<string, ZcodeAsk>();
  const texts = new Map<number, { streamed: number; sealed: boolean }>();
  const tools = new Map<string, "started" | "done">();
  const endedTurns = new Set<string>();
  let session: Session | undefined;
  let baseline: ConversationState["usage"]["cumulative"] | undefined;
  let inputId: string | null = null;
  let settled = false;
  let stopRequested = false;
  let nudged = false;
  let resumes = 0;
  let resumeTimer: ReturnType<typeof setTimeout> | null = null;
  let markSettled = () => {};
  const settledSignal = new Promise<void>((resolve) => { markSettled = resolve; });

  const usageSoFar = (): Usage | undefined => {
    const now = session?.state.usage.cumulative;
    if (!now || !baseline) return undefined;
    return {
      input: now.inputTokens - baseline.inputTokens,
      output: now.outputTokens - baseline.outputTokens,
      cachedInput: now.cacheReadTokens - baseline.cacheReadTokens,
    };
  };

  const settle = async (ok: boolean, stopReason: string | null) => {
    if (settled) return;
    settled = true;
    markSettled();
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = null;
    for (const finish of Array.from(asks.values())) finish("deny", "Legion: the turn ended", "system");
    const usage = usageSoFar();
    await conn.close(CLOSE_GRACE_MS);
    sink.finish(ok, stopReason, usage);
  };

  const failTurn = (message: string, stopReason: string) => {
    if (settled || stopRequested) return;
    emit({ type: "runtime.error", message });
    void settle(false, stopReason);
  };

  const send = async (text: string, attachments?: Awaited<ReturnType<Session["uploadAttachment"]>>[]) => {
    const accepted = await session!.sendText(text, { mode: turn.mode, ...(attachments?.length ? { attachments } : {}) });
    inputId = accepted.inputId;
    checkTurnEnd(session!.state);
  };

  // Answers go through the session; a v1 `interaction/*` reply would withdraw the ask (measured on 0.16.9).
  const answer = (interaction: PendingInteraction, behavior: ZcodeAskBehavior, message?: string) => {
    const live = session!;
    const id = interaction.interactionId;
    const reply = (): Promise<unknown> => {
      if (interaction.kind === "question")
        return behavior === "answer" && message?.trim() ? live.answer(id, [message]) : live.decline(id);
      if (interaction.kind === "unknown") return live.decline(id);
      if (behavior === "deny") {
        const deniable = interaction.kind === "planApproval" || interaction.options.some((option) => option.kind === "deny");
        return deniable ? live.approve(id, "deny", message) : live.decline(id);
      }
      if (interaction.kind === "permission" && !interaction.options.some((option) => option.kind === "allowOnce")) {
        emit({ type: "runtime.notice", message: "ZCode offered no allow-once option for this request, so it was denied." });
        return live.decline(id);
      }
      return live.approve(id, "allowOnce");
    };
    void reply().catch((error) => {
      if (settled || error instanceof InteractionNotPendingError) return;
      emit({ type: "runtime.notice", message: `ZCode did not take the answer: ${errorText(error)}` });
    });
  };

  const openAsk = (interaction: PendingInteraction) => {
    const id = interaction.interactionId;
    if (asks.has(id)) return;
    if (interaction.kind === "unknown") {
      emit({ type: "runtime.notice", message: `ZCode asked for a ${interaction.wireKind} decision Legion cannot show; it was declined.` });
      answer(interaction, "deny");
      return;
    }
    // Never allowAlways: ZCode stores it as a standing project rule (measured).
    if (turn.autoAllow && interaction.kind === "permission" && interaction.options.some((option) => option.kind === "allowOnce")) {
      answer(interaction, "allow");
      return;
    }
    const timer = setTimeout(() => finish("deny", DENY_TIMEOUT_NOTE, "timeout"), ASK_TIMEOUT_MS);
    timer.unref?.();
    const finish: ZcodeAsk = (behavior, message, source = "user") => {
      if (!asks.delete(id)) return;
      clearTimeout(timer);
      if (source !== "system") answer(interaction, behavior, message);
      emit({ type: "request.resolved", requestId: id, behavior, source });
    };
    asks.set(id, finish);
    emit({ type: "request.opened", requestId: id, ...cardFor(interaction) });
  };

  const textOf = (rowId: number) => {
    let entry = texts.get(rowId);
    if (!entry) texts.set(rowId, entry = { streamed: 0, sealed: false });
    return entry;
  };

  // Each assistant message becomes its own item where it ends, so interim commentary reaches the thread mid-turn.
  const seal = (row: Extract<Row, { kind: "assistantText" }>) => {
    const entry = textOf(row.rowId);
    if (entry.sealed) return;
    entry.sealed = true;
    const rest = row.text.slice(entry.streamed);
    if (rest) emit({ type: "content.delta", streamKind: "assistant_text", delta: rest });
    const text = row.text.trim();
    if (text) emit({ type: "item.completed", itemType: "assistant_text", text });
  };
  const sealOpen = (state: ConversationState, except?: number) => {
    for (const row of state.rows)
      if (row.kind === "assistantText" && row.rowId !== except && texts.has(row.rowId)) seal(row);
  };

  const onRow = (row: Row, state: ConversationState) => {
    if (row.kind === "assistantText") {
      sealOpen(state, row.rowId);
      textOf(row.rowId);
      if (row.state !== "streaming") seal(row);
      return;
    }
    if (row.kind !== "toolCall") return;
    sealOpen(state);
    const seen = tools.get(row.toolCallId);
    if (row.status === "inputStreaming" || seen === "done") return;
    if (!seen) {
      tools.set(row.toolCallId, "started");
      emit({
        type: "item.started", itemType: "tool", itemId: row.toolCallId, title: row.toolName || "tool",
        summary: commandSummary(row.input), input: toolDetailPreview(row.input),
      });
    }
    if (row.status === "success" || row.status === "error" || row.status === "cancelled") {
      tools.set(row.toolCallId, "done");
      emit({ type: "item.completed", itemType: "tool", itemId: row.toolCallId, ok: row.status === "success", output: toolDetailPreview(row.output?.text ?? row.status) });
    }
  };

  const onEvent = (event: SessionEvent) => {
    switch (event.type) {
      case "snapshot":
        // A resumed session's history is already in the thread.
        for (const row of event.state.rows) {
          if (row.kind === "assistantText") texts.set(row.rowId, { streamed: row.text.length, sealed: true });
          if (row.kind === "toolCall") tools.set(row.toolCallId, "done");
        }
        break;
      case "delta": {
        const { delta, state } = event;
        if (delta.op === "row.appended" || delta.op === "row.upserted") onRow(delta.row, state);
        if (delta.op !== "row.delta" || delta.path !== "text") break;
        const row = state.rows.find((candidate) => candidate.rowId === delta.rowId);
        if (row?.kind === "reasoning") emit({ type: "content.delta", streamKind: "reasoning_text", delta: delta.append });
        if (row?.kind !== "assistantText") break;
        const entry = textOf(row.rowId);
        if (entry.sealed) break;
        entry.streamed += delta.append.length;
        emit({ type: "content.delta", streamKind: "assistant_text", delta: delta.append });
        break;
      }
      case "interactionRequested":
        openAsk(event.interaction);
        break;
      case "interactionResolved":
        asks.get(event.interaction.interactionId)?.("deny", undefined, "system");
        break;
    }
    checkTurnEnd(event.state);
  };

  // A turn zcode gave up on after its own stream recoveries leaves its session
  // intact: continue the same session after a backoff.
  const beginResume = (reason: string) => {
    resumes += 1;
    const nominalMs = zcodeResumeDelayMs(resumes);
    emit({
      type: "runtime.notice",
      message: `ZCode lost its provider connection (${reason}). Resuming in ${Math.round(nominalMs / 1000)}s (resume ${resumes} of ${ZCODE_MAX_TURN_RESUMES}).`,
    });
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      if (settled || stopRequested) return;
      send(ZCODE_RESUME_PROMPT).catch((error) => failTurn(`zcode could not resume after a network failure: ${errorText(error)}`, "resume_failed"));
    }, Math.max(1, Math.round(nominalMs * turn.retryScale)));
  };

  const checkTurnEnd = (state: ConversationState) => {
    const header = inputId ? turnForCommand(state, inputId) : undefined;
    if (settled || !header || header.state === "running" || endedTurns.has(header.turnId)) return;
    endedTurns.add(header.turnId);
    sealOpen(state);
    if (header.state === "completedSuccess") {
      const reply = state.rows.filter((row) => row.kind === "assistantText" && row.turnId === header.turnId).at(-1);
      if (!stopRequested && !nudged && reply?.kind === "assistantText" && announcesAction(reply.text)) {
        nudged = true;
        send(CONTINUATION_NUDGE).catch((error) => failTurn(`zcode continuation failed: ${errorText(error)}`, "continuation_failed"));
        return;
      }
      void settle(true, null);
      return;
    }
    if (header.state === "completedInterrupted") {
      void settle(true, "interrupted");
      return;
    }
    const error = state.control.lastError;
    if (!stopRequested && resumes < ZCODE_MAX_TURN_RESUMES && isTransientZcodeFailure(error)) {
      beginResume(zcodeFailureReason(error) ?? "provider error");
      return;
    }
    const message = typeof (error as { message?: unknown } | null)?.message === "string" && (error as { message: string }).message
      ? (error as { message: string }).message
      : "zcode turn failed";
    emit({ type: "runtime.error", message });
    void settle(false, classifyError({ text: message }).reason === "provider_safety" ? "provider_safety" : "failed");
  };

  const follow = async (live: Session) => {
    try {
      for await (const event of live.events()) {
        if (settled) return;
        onEvent(event);
      }
    } catch (error) {
      failTurn(errorText(error), "exit_before_result");
    }
  };

  const mcpServers = async (): Promise<McpServer[]> => {
    const harness = new Set(turn.harnessMcpServers.map((server) => server.name));
    // A non-empty list replaces the servers ZCode would load from its config files (measured on 0.16.9), so they ride along.
    const fromFiles = await loadZCodeMcpServers({ cwd: turn.cwd, env: turn.env }).catch((error: unknown) => {
      emit({ type: "runtime.notice", message: `ZCode MCP servers from config files are left out of this turn: ${errorText(error)}` });
      return [];
    });
    return [...fromFiles.filter((server) => !harness.has(server.name) && turn.allowMcpServer(server.name)), ...turn.harnessMcpServers];
  };

  const run = async () => {
    const servers = await mcpServers();
    if (turn.resumeSessionId) {
      // A v4 cold resume drops the servers the session was created with (measured on 0.16.9); v1 resume carries them.
      await conn.wire.request("session/resume", {
        sessionId: turn.resumeSessionId,
        workspace: { workspacePath: turn.cwd, workspaceKey: turn.cwd },
        ...(servers.length ? { mcpServers: servers } : {}),
      });
      session = await conn.openSession(turn.resumeSessionId as SessionId);
    } else {
      session = await conn.createSession({ workspaceId: turn.cwd, ...(servers.length ? { mcpServers: servers } : {}), config: { mode: turn.mode } });
    }
    baseline = session.state.usage.cumulative;
    emit({ type: "session.started", sessionId: session.id, model: null });
    if (turn.model) {
      const current = session.state.config;
      const sameModel = current.provider === turn.model.provider && current.model === turn.model.model;
      const thought = turn.model.thought ?? (sameModel ? current.thought ?? "" : "");
      await applySessionConfig(session, { model: { provider: turn.model.provider, model: turn.model.model, thought } });
    }
    const attachments = [];
    for (const image of turn.images)
      attachments.push(await session.uploadAttachment({ fileName: basename(image.path), mime: image.mime, data: await readFile(image.path) }));
    void follow(session);
    await send(turn.text, attachments);
  };

  void run().catch((error) => {
    if (settled || stopRequested) return;
    const message = errorText(error);
    const needsAuth = /(?:\b401\b|unauthorized|not signed in|login required|authentication)/i.test(message);
    emit({ type: "runtime.error", message, ...(needsAuth ? { setup: true } : {}) });
    void settle(false, needsAuth ? "auth_required" : "setup_failed");
  });

  const stop = async (): Promise<boolean> => {
    stopRequested = true;
    if (settled) return true;
    // Requests run in order on the child and an idle stop is accepted (measured), so this also reaches a send in flight.
    if (session && !resumeTimer) {
      await Promise.race([session.stop().catch(() => undefined), delay(STOP_ACK_MS)]);
      await Promise.race([settledSignal, delay(STOP_GRACE_MS)]);
    }
    await settle(true, "interrupted");
    return true;
  };

  return { stop, asks };
}
