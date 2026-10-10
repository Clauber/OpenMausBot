// @vitest-environment happy-dom
// A person's own message renders through the same ChatMarkdown a bot reply
// does when it is visibly structured Markdown (a pasted brief, a list, code),
// and stays exactly the plain pre-wrap text it always was otherwise.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo, Message } from "@/state/store";

vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null, ThinkingPicker: () => null }));

const { ChatView } = await import("./ChatView");
const { BotEditorStore, initialState } = await import("@/state/store");

const PLAIN_BUBBLE = "w-fit max-w-[min(42rem,78%)] rounded-2xl text-[15px] leading-relaxed bg-bubble-user px-4 py-2.5 whitespace-pre-wrap text-ink";

const BRIEF = [
  "# Task: Deploy Dkron Cron Scheduler on SSD-Nodes",
  "",
  "## Steps",
  "- install the binary",
  "- start the service",
  "",
  "```sh",
  "systemctl start dkron",
  "```",
].join("\n");
const LONG_WORD = "x".repeat(400);

const user = (id: string, text: string): Message => ({ id, role: "user", kind: "text", at: Date.now() - 1000, text });
const messages: Message[] = [
  user("plain", "Audit the payroll spreadsheet"),
  user("plain-multi", "line one\nline two with snake_case and **stars**"),
  user("long", LONG_WORD),
  user("multi", `Please do this:\n\n${BRIEF}`),
  user("paste", `<pasted-text index="1">\n${BRIEF}\n</pasted-text>`),
  user("typed-and-paste", `Please review:\n<pasted-text index="2">\n- one\n- two\n</pasted-text>`),
];
const profile: Bot = {
  id: "pepper", threadId: "pepper-thread", name: "pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages, modelSelection: { instanceId: "test", model: "m" },
  tasks: [{ threadId: "pepper-thread", title: "Thread", createdAt: 1, busy: false, activity: "idle", modelSelection: { instanceId: "test", model: "m" }, approvalMode: "ask" }],
};
const state: AppState = {
  ...initialState,
  connected: true,
  selectedId: "pepper",
  bots: [profile],
  instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" } } as InstanceInfo],
  config: { features: {} } as AppState["config"],
};
let root: Root;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const row = (id: string) => document.querySelector(`[data-mid="${id}"]`)!;
const bubble = (id: string) => row(id).querySelector<HTMLElement>("[data-chat-bubble]")!;

beforeAll(async () => {
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const value = { state, dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  flushSync(() => root.render(createElement(BotEditorStore, { value, children: createElement(ChatView, { bot: profile }) })));
  await settle();
  await settle();
});
afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
});

describe("user message bubble", () => {
  it("leaves a plain single-line message exactly as it was", () => {
    const el = bubble("plain");
    expect(el.className).toBe(PLAIN_BUBBLE);
    expect(el.querySelector(".chat-md")).toBeNull();
    const body = el.querySelector(".chat-text")!;
    expect(body.className).toBe("chat-text");
    expect(body.textContent).toBe("Audit the payroll spreadsheet");
    expect(body.children).toHaveLength(0);
  });

  it("leaves multi-line prose without structure as pre-wrapped text, markers literal", () => {
    const el = bubble("plain-multi");
    expect(el.className).toBe(PLAIN_BUBBLE);
    expect(el.querySelector(".chat-md")).toBeNull();
    expect(el.querySelector(".chat-text")!.textContent).toBe("line one\nline two with snake_case and **stars**");
  });

  it("keeps a long unbroken line in the pre-wrap bubble that wraps it", () => {
    const el = bubble("long");
    expect(el.className).toBe(PLAIN_BUBBLE);
    expect(el.querySelector(".chat-text")!.textContent).toBe(LONG_WORD);
  });

  it("renders a structured message through ChatMarkdown: headings, list, code block with Copy", () => {
    const el = bubble("multi");
    expect(el.className).not.toContain("whitespace-pre-wrap");
    expect(el.className).toContain("bg-bubble-user");
    const md = el.querySelector(".chat-md")!;
    expect(md).not.toBeNull();
    expect(md.querySelector(".text-\\[16px\\].font-semibold")!.textContent).toBe("Task: Deploy Dkron Cron Scheduler on SSD-Nodes");
    expect(md.querySelector(".text-\\[15\\.5px\\].font-semibold")!.textContent).toBe("Steps");
    expect([...md.querySelectorAll("ul.list-disc > li")].map((li) => li.textContent)).toEqual(["install the binary", "start the service"]);
    expect(md.querySelector("p")!.textContent).toBe("Please do this:");
    expect(md.querySelectorAll('button[aria-label="Copy code to clipboard"]')).toHaveLength(1);
    expect(md.textContent).not.toContain("## ");
    expect(md.textContent).not.toContain("```");
  });

  it("renders the content of a pasted-text block as Markdown and keeps the wrapper hidden", () => {
    const el = bubble("paste");
    const md = el.querySelector(".chat-md")!;
    expect(md.querySelector(".text-\\[16px\\].font-semibold")!.textContent).toBe("Task: Deploy Dkron Cron Scheduler on SSD-Nodes");
    expect(md.querySelector(".text-\\[15\\.5px\\].font-semibold")!.textContent).toBe("Steps");
    expect(md.querySelectorAll("ul.list-disc > li")).toHaveLength(2);
    expect(md.querySelectorAll('button[aria-label="Copy code to clipboard"]')).toHaveLength(1);
    expect(el.textContent).not.toContain("pasted-text");
    expect(el.className).not.toContain("whitespace-pre-wrap");
  });

  it("renders typed text before a paste together with the pasted list", () => {
    const el = bubble("typed-and-paste");
    expect(el.querySelector(".chat-md p")!.textContent).toBe("Please review:");
    expect(el.querySelectorAll(".chat-md li")).toHaveLength(2);
    expect(el.textContent).not.toContain("pasted-text");
  });
});
