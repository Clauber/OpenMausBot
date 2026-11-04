// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo, Message } from "@/state/store";

vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
  useCaptionChrome: () => ({}),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true, useReactor: () => "user" }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

const { ChatView } = await import("./ChatView");
const { BotEditorStore, initialState } = await import("@/state/store");
const { setAdvancedMode } = await import("@/lib/interface-mode");

const messages = ([
  { id: "ask", role: "user", kind: "text", at: 1_000, text: "Find the file" },
  { id: "search", role: "bot", kind: "activity", at: 1_200, turnId: "turn", tool: { name: "Bash", ok: true, input: "ls", output: "found.txt" } },
  { id: "read", role: "bot", kind: "activity", at: 1_400, turnId: "turn", tool: { name: "Read", ok: false, input: "missing.txt", output: "File not found: missing.txt" } },
  { id: "answer", role: "bot", kind: "text", at: 2_000, turnId: "turn", turnTerminal: true, text: "Here is the file I found." },
  { id: "digest", role: "bot", kind: "digest", at: 2_050, turnId: "turn", digest: { turnId: "turn", threadId: "thread", botId: "bot", at: 2_050, durationMs: 639, reply: "Here is the file I found.", tools: [{ name: "Bash", count: 1, failed: 0 }, { name: "Read", count: 1, failed: 1 }], toolCalls: 2, memory: [], hookCoverage: "preview" } },
] satisfies Message[]).map((message, index, all): Message => ({ ...message, parentId: all[index - 1]?.id }));

function mount({ showToolCalls = true, advanced = false, focusedId, rows = messages }: { showToolCalls?: boolean; advanced?: boolean; focusedId?: string; rows?: Message[] } = {}) {
  setAdvancedMode(advanced);
  const bot: Bot = {
    id: "bot", threadId: "thread", name: "Pepper", title: "", description: "", color: "green", notifications: true, unread: false, busy: false,
    messages: rows, activeLeafId: rows.at(-1)?.id, modelSelection: { instanceId: "test", model: "m" },
    tasks: [{ threadId: "thread", title: "Thread", createdAt: 1, busy: false, activity: "idle", modelSelection: { instanceId: "test", model: "m" }, approvalMode: "ask" }],
  };
  const state: AppState = {
    ...initialState, connected: true, selectedId: "bot", bots: [bot],
    instances: [{ instanceId: "test", driverKind: "claude", displayName: "Claude", snapshot: { state: "available" } } as InstanceInfo],
    config: { features: { showToolCalls } } as AppState["config"],
    ...(focusedId ? { focusMessage: { threadId: "thread", messageId: focusedId, nonce: 1, consumed: false } } : {}),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const value = { state, dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  flushSync(() => root.render(createElement(BotEditorStore, { value, children: createElement(ChatView, { bot }) })));
  return { container, unmount: () => { root.unmount(); container.remove(); } };
}

afterEach(() => { vi.unstubAllGlobals(); setAdvancedMode(false); });

describe("completed turn activity", () => {
  it.each([false, true])("attaches one neutral collapsed summary to the answer, advanced=%s", (advanced) => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const { container, unmount } = mount({ advanced });
    try {
      const log = container.querySelector("[role=log]")!;
      const summaries = log.querySelectorAll<HTMLElement>('[data-testid="turn-activity"]');
      expect(summaries).toHaveLength(1);
      expect(container.querySelector('[data-mid="answer"]')?.contains(summaries[0]!)).toBe(true);
      const button = summaries[0]!.querySelector<HTMLButtonElement>("button")!;
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(button.getAttribute("aria-label")).toContain("activity");
      expect(button.textContent).toContain("639ms");
      expect(button.textContent).toContain("1 failed");
      expect(button.className).not.toMatch(/danger|error|red/);
      expect(log.textContent?.match(/Worked for/g)).toHaveLength(1);
      expect(log.querySelector('[data-mid="read"]')).toBeNull();
      expect(log.querySelector('[data-testid="digest-chip"]')).toBeNull();
      flushSync(() => button.click());
      expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(log.querySelector('[data-mid="search"]')).not.toBeNull();
      expect(log.querySelector('[data-mid="read"]')?.textContent).toContain("File not found: missing.txt");
      expect(summaries[0]!.textContent).toContain("A reply arrived");
      expect(summaries[0]!.querySelector('[data-testid="view-trace"]')?.textContent).toBe("View trace");
    } finally { unmount(); }
  });

  it("opens the activity when a failed step is focused", () => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const { container, unmount } = mount({ focusedId: "read" });
    try {
      expect(container.querySelector('[data-testid="turn-activity"] button')?.getAttribute("aria-expanded")).toBe("true");
      expect(container.querySelector('[data-mid="read"]')).not.toBeNull();
    } finally { unmount(); }
  });

  it.each([false, true])("shows no activity row or failed tool pill when tool calls are hidden, advanced=%s", (advanced) => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const { container, unmount } = mount({ showToolCalls: false, advanced });
    try {
      const log = container.querySelector("[role=log]")!;
      expect(log.textContent).toContain("Here is the file I found.");
      expect(log.querySelector('[data-testid="turn-activity"]')).toBeNull();
      expect(log.querySelector('[data-mid="read"]')).toBeNull();
      expect(log.textContent).not.toContain("Worked for");
    } finally { unmount(); }
  });
});
