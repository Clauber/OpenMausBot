import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, Group, Message } from "@/state/store";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return { state: null as Partial<AppState> | null, dispatch: vi.fn() };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({ state: { ...original.initialState, ...fixture.state }, dispatch: fixture.dispatch }),
  };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { GroupView } = await import("./GroupView");

afterEach(() => { fixture.state = null; vi.clearAllMocks(); });

const bot: Bot = {
  id: "aleta", threadId: "t-aleta", name: "Aleta", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [],
  modelSelection: { instanceId: "test", model: "profile-default" },
};
const room = (messages: Message[]): Group => ({
  id: "room", threadId: "room-thread", name: "Job search", memberIds: ["aleta"],
  defaultResponder: { kind: "everyone" }, bulletin: "", unread: false, createdAt: 1, messages,
});
const user = (text: string): Message => ({ id: "u1", role: "user", kind: "text", at: 1, text });
const render = (message: Message) => {
  fixture.state = { bots: [bot] };
  return renderToStaticMarkup(createElement(GroupView, { group: room([message]) }));
};
const bubbleOf = (markup: string) => { const m = /data-chat-bubble[^>]*?class="([^"]*)"/.exec(markup) ?? /class="([^"]*)"[^>]*data-chat-bubble/.exec(markup); if (!m) throw new Error(markup.slice(0, 1500)); return m[1]!; };

const PLAIN_BUBBLE = "w-fit max-w-[min(42rem,78%)] rounded-2xl text-[15px] leading-relaxed chat-text whitespace-pre-wrap bg-bubble-user px-4 py-2.5 text-ink";

describe("GroupView user bubble", () => {
  it("leaves a plain message exactly as it was", () => {
    const markup = render(user("Look at the job board"));
    expect(bubbleOf(markup)).toBe(PLAIN_BUBBLE);
    expect(markup).not.toContain("chat-md");
    expect(markup).toContain("Look at the job board");
  });

  it("renders a structured message through ChatMarkdown", () => {
    const markup = render(user("Plan:\n\n## Steps\n- one\n- two\n\n```sh\nls\n```"));
    expect(bubbleOf(markup)).not.toContain("whitespace-pre-wrap");
    expect(markup).toContain("chat-md");
    expect(markup).toContain('<ul dir="ltr" class="list-disc space-y-1 ps-5">');
    expect(markup).toContain("Copy code to clipboard");
    expect(markup).not.toContain("## Steps");
  });

  it("renders pasted content as Markdown with the wrapper hidden", () => {
    const markup = render(user('<pasted-text index="1">\n# Task: Deploy\n- one\n- two\n</pasted-text>'));
    expect(markup).toContain("chat-md");
    expect(markup).toContain("Task: Deploy");
    expect(markup).not.toContain("pasted-text");
  });
});
