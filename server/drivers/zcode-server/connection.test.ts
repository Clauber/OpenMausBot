import { describe, expect, it, vi } from "vitest";

import { ZcodeChannelError, type ZcodeChannelClient } from "./channel.ts";
import { ackSettled, openServerTransport, optionIdForResponse, serverEventRecord, uuidv7 } from "./connection.ts";
import type { ZcodeTransportHandlers } from "../zcode-transport.ts";

const OPTIONS = [
  { optionId: "allow_once", kind: "allow_once", response: { decision: "allow", reason: "once" } },
  { optionId: "deny", kind: "deny", response: { decision: "deny", reason: "no" } },
];
const WORKSPACE = "/work/space";

describe("event mapping", () => {
  it("turns channel events into app-server records and drops the rest", () => {
    expect(serverEventRecord({ type: "session.event", event: { type: "turn.started" } })).toEqual({ kind: "event", params: { type: "turn.started" } });
    expect(serverEventRecord({ type: "permission.request", request: { requestId: "p1" } })).toEqual({
      kind: "request", id: "p1", method: "interaction/requestPermission", params: { requestId: "p1" },
    });
    expect(serverEventRecord({ type: "userInput.request", request: { requestId: "q1" } })).toMatchObject({ method: "interaction/requestUserInput" });
    expect(serverEventRecord({ type: "state.updated" })).toBeUndefined();
    expect(serverEventRecord({ type: "permission.request", request: {} })).toBeUndefined();
  });

  it("finds the answered option, falls back to the same decision, and accepts only settled acks", () => {
    expect(optionIdForResponse(OPTIONS, OPTIONS[0]!.response)).toBe("allow_once");
    expect(optionIdForResponse(OPTIONS, { decision: "deny" })).toBe("deny");
    expect(optionIdForResponse(OPTIONS, { decision: "maybe" })).toBeUndefined();
    expect(ackSettled({ status: "noop" })).toBe(true);
    expect(ackSettled({ status: "rejected" })).toBe(false);
  });

  it("makes version 7 command ids", () => {
    expect(uuidv7(1_700_000_000_000)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

function harness(options: { ack?: string; projects?: unknown[]; failOn?: Record<string, ZcodeChannelError> } = {}) {
  const calls: Array<{ channel: string; method: string; args: readonly unknown[] }> = [];
  let emit: (value: unknown) => void = () => {};
  let end: () => void = () => {};
  let close: () => void = () => {};
  const closedPromise = new Promise<void>((resolve) => { close = resolve; });
  const client: ZcodeChannelClient = {
    call: async (channel, method, args = []) => {
      calls.push({ channel, method, args });
      const failure = options.failOn?.[method];
      if (failure) throw failure;
      switch (method) {
        case "readProjects": return options.projects ?? [];
        case "saveProject": return { id: "project-new" };
        case "createSession":
        case "resumeSession": return { session: { sessionId: "session-1" } };
        case "helloConversationV4": return { protocolVersion: 4 };
        case "sendConversationCommandV4": return { status: options.ack ?? "accepted" };
        default: return {};
      }
    },
    listen: (_channel, _event, _arg, onEvent, onEnd) => {
      emit = onEvent;
      end = () => onEnd?.();
      return () => {};
    },
    close: () => close(),
    closed: closedPromise,
  };
  const handlers = { serverRequest: vi.fn(), event: vi.fn(), failed: vi.fn() } satisfies ZcodeTransportHandlers;
  const release = vi.fn();
  const open = () => openServerTransport(
    { endpoint: { url: "ws://127.0.0.1:1/ws", token: "fake" }, workspacePath: WORKSPACE, identity: "bot-a", threadId: "thread", release, connect: async () => client },
    handlers,
  );
  const called = (method: string) => calls.filter((call) => call.method === method);
  return { open, calls, called, handlers, release, emit: (value: unknown) => emit(value), end: () => end(), closeSocket: () => close() };
}

const envelopeOf = (call: { args: readonly unknown[] } | undefined) =>
  (call!.args[0] as { envelope: { commandId: string; type: string; payload: unknown; sessionId: string } }).envelope;

describe("openServerTransport", () => {
  it("creates a session in the workspace's single-root project and sends prompts to it", async () => {
    const h = harness();
    const transport = await h.open();
    const created = await transport.request("session/create", { workspace: { workspacePath: WORKSPACE, workspaceKey: WORKSPACE }, mode: "build" });
    expect(created).toEqual({ session: { sessionId: "session-1" } });
    expect(h.called("saveProject")[0]!.args).toEqual([{ roots: [WORKSPACE] }]);
    expect(h.called("createSession")[0]!.args).toEqual([{ mode: "build", workspacePath: WORKSPACE, workspaceIdentity: "bot-a", projectId: "project-new" }]);
    await transport.request("session/send", { sessionId: "session-1", content: "hi" });
    expect(h.called("sendPrompt")[0]!.args).toEqual([{ sessionId: "session-1", content: "hi", workspacePath: WORKSPACE, workspaceIdentity: "bot-a" }]);
  });

  it("reuses a project that already has the workspace as its only root", async () => {
    const h = harness({ projects: [
      { id: "other", roots: ["/other"] },
      { id: "wide", roots: [WORKSPACE, "/second"] },
      { id: "gone", roots: [WORKSPACE], deletedAt: 1 },
      { id: "mine", roots: [WORKSPACE] },
    ] });
    const transport = await h.open();
    await transport.request("session/resume", { sessionId: "session-1" });
    expect(h.called("saveProject")).toHaveLength(0);
    expect(h.called("resumeSession")[0]!.args[0]).toMatchObject({ projectId: "mine", sessionId: "session-1" });
  });

  it("delivers session events and routes an answered permission through v4 after one handshake", async () => {
    const h = harness();
    const transport = await h.open();
    await transport.request("session/create", { mode: "build" });
    await transport.request("session/subscribe", { sessionId: "session-1", deliveryKind: "desktop-continuous" });
    h.emit({ type: "session.event", event: { type: "turn.started", sessionId: "session-1" } });
    expect(h.handlers.event).toHaveBeenCalledWith({ type: "turn.started", sessionId: "session-1" });

    h.emit({ type: "permission.request", request: { requestId: "p1", options: OPTIONS } });
    expect(h.handlers.serverRequest).toHaveBeenCalledWith({ id: "p1", method: "interaction/requestPermission", params: { requestId: "p1", options: OPTIONS } });
    transport.respond("p1", OPTIONS[0]!.response);
    transport.respond("p1", OPTIONS[0]!.response);
    await vi.waitFor(() => expect(h.called("sendConversationCommandV4")).toHaveLength(1));
    expect(h.called("helloConversationV4")).toHaveLength(1);
    expect(h.called("initializeConversationV4")).toHaveLength(1);
    const envelope = envelopeOf(h.called("sendConversationCommandV4")[0]);
    expect(envelope).toMatchObject({ type: "resolveInteraction", sessionId: "session-1", payload: { interactionId: "p1", answer: { optionId: "allow_once" } } });
    expect(h.called("sendConversationCommandV4")[0]!.args[0]).toMatchObject({ workspacePath: WORKSPACE, workspaceIdentity: "bot-a" });
  });

  it("answers a user-input ask with the driver's answer verbatim", async () => {
    const h = harness();
    const transport = await h.open();
    await transport.request("session/create", {});
    await transport.request("session/subscribe", { sessionId: "session-1" });
    h.emit({ type: "userInput.request", request: { requestId: "q1" } });
    transport.respond("q1", { action: "accept", content: { value: "alpha" } });
    await vi.waitFor(() => expect(h.called("sendConversationCommandV4")).toHaveLength(1));
    expect(envelopeOf(h.called("sendConversationCommandV4")[0]).payload).toEqual({ interactionId: "q1", answer: { action: "accept", content: { value: "alpha" } } });
  });

  it("stops a turn with a v4 stop and steers with guided delivery", async () => {
    const h = harness();
    const transport = await h.open();
    await transport.request("session/stop", { sessionId: "session-9" });
    expect(envelopeOf(h.called("sendConversationCommandV4")[0])).toMatchObject({ type: "stop", sessionId: "session-9", payload: {} });
    expect(await transport.steer("session-9", "use tabs")).toBe("steered");
    expect(envelopeOf(h.called("sendConversationCommandV4")[1])).toMatchObject({
      type: "sendText", sessionId: "session-9", payload: { text: "use tabs", requestedDelivery: "guide" },
    });
  });

  it("refuses a steer the server rejected and reports a failed one as indeterminate", async () => {
    const rejected = harness({ ack: "rejected" });
    expect(await (await rejected.open()).steer("s", "x")).toBe("refused");
    const broken = harness({ failOn: { sendConversationCommandV4: new ZcodeChannelError("call", "Error (X)") } });
    expect(await (await broken.open()).steer("s", "x")).toBe("indeterminate");
  });

  it("fails a stop the server did not settle", async () => {
    const h = harness({ ack: "failed" });
    const transport = await h.open();
    await expect(transport.request("session/stop", { sessionId: "s" })).rejects.toThrow("ZCode stop failed: failed");
  });

  it("explains a missing sign-in and keeps other channel failures to their category", async () => {
    const h = harness({ failOn: {
      createSession: new ZcodeChannelError("call", "Error (ZCODE_AGENT_PROVIDER_NOT_READY)"),
      sendPrompt: new ZcodeChannelError("call", "TypeError (E_BOOM)"),
    } });
    const transport = await h.open();
    await expect(transport.request("session/create", {})).rejects.toThrow(/not signed in/);
    await expect(transport.request("session/send", {})).rejects.toThrow("ZCode sendPrompt failed: TypeError (E_BOOM)");
    await expect(transport.request("session/nope", {})).rejects.toThrow("unsupported");
  });

  it("reports a lost connection once, returns the lease on close, and stays quiet once muted", async () => {
    const lost = harness();
    await lost.open();
    lost.closeSocket();
    await vi.waitFor(() => expect(lost.handlers.failed).toHaveBeenCalledWith({ message: expect.stringMatching(/connection to the ZCode server was lost/), stopReason: "connection_lost" }));

    const quiet = harness();
    const transport = await quiet.open();
    transport.mute();
    quiet.closeSocket();
    await Promise.resolve();
    expect(quiet.handlers.failed).not.toHaveBeenCalled();
    expect(await transport.close()).toBe(true);
    expect(await transport.close()).toBe(true);
    expect(quiet.release).toHaveBeenCalledTimes(1);
    expect(transport.alive()).toBe(false);
  });

  it("returns the lease when the socket cannot be opened", async () => {
    const release = vi.fn();
    await expect(openServerTransport(
      { endpoint: { url: "ws://127.0.0.1:1/ws", token: "fake" }, workspacePath: WORKSPACE, identity: "bot-a", threadId: "t", release,
        connect: async () => { throw new ZcodeChannelError("open", "ECONNREFUSED"); } },
      { serverRequest: vi.fn(), event: vi.fn(), failed: vi.fn() },
    )).rejects.toThrow("ZCode connect failed: ECONNREFUSED");
    expect(release).toHaveBeenCalledTimes(1);
  });
});
