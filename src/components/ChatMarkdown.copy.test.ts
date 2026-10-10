// @vitest-environment happy-dom
// The Copy button on chat code blocks and diagrams: success feedback, the
// textarea fallback when the Clipboard API is missing or rejects, and a visible
// error when nothing can reach the clipboard (it used to do nothing at all).
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), render: vi.fn(() => Promise.reject(new Error("no renderer in test"))) },
}));

const { CodeBlock, MermaidDiagram } = await import("./ChatMarkdown");
const { setLocale } = await import("@/lib/i18n");

const URL_LINE = "https://example.com/felt-righteous?utm=1";
const setClipboard = (value: unknown) => Object.defineProperty(navigator, "clipboard", { value, configurable: true });

/** execCommand spy that records what the hidden textarea held when it ran. */
const stubExecCommand = (result: boolean) => {
  const copied: string[] = [];
  const exec = vi.fn(() => {
    copied.push(document.querySelector("textarea")?.value ?? "");
    return result;
  });
  Object.defineProperty(document, "execCommand", { value: exec, configurable: true });
  return { exec, copied };
};

let root: Root;
let container: HTMLElement;

const mount = (block: "code" | "diagram") => {
  root.render(block === "code"
    ? createElement(CodeBlock, { code: URL_LINE, lang: "text" })
    : createElement(MermaidDiagram, { code: URL_LINE }));
};
const copyButton = () => {
  const button = container.querySelector<HTMLButtonElement>("button[data-copy-state]");
  if (!button) throw new Error(`no copy button in: ${container.innerHTML}`);
  return button;
};
const clickCopy = async (block: "code" | "diagram") => {
  mount(block);
  await vi.waitFor(() => expect(container.querySelector("button")).not.toBeNull());
  copyButton().click();
};

beforeEach(() => {
  setLocale("en");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  root.unmount();
  container.remove();
  setClipboard(undefined);
  Reflect.deleteProperty(document, "execCommand");
  vi.useRealTimers();
});

describe.each(["code", "diagram"] as const)("%s block copy button", (block) => {
  it("shows Copied! when the Clipboard API accepts the text", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    setClipboard({ writeText });
    await clickCopy(block);
    await vi.waitFor(() => expect(container.textContent).toContain("Copied!"));
    expect(writeText).toHaveBeenCalledWith(URL_LINE);
    expect(container.textContent).not.toContain("Copy failed");
  });

  it("still copies and shows Copied! when navigator.clipboard is missing (webview/insecure context)", async () => {
    setClipboard(undefined);
    const { copied } = stubExecCommand(true);
    await clickCopy(block);
    await vi.waitFor(() => expect(container.textContent).toContain("Copied!"));
    expect(copied).toEqual([URL_LINE]);
  });

  it("falls back to the textarea when writeText rejects", async () => {
    setClipboard({ writeText: vi.fn(() => Promise.reject(new DOMException("denied", "NotAllowedError"))) });
    const { copied } = stubExecCommand(true);
    await clickCopy(block);
    await vi.waitFor(() => expect(container.textContent).toContain("Copied!"));
    expect(copied).toEqual([URL_LINE]);
  });

  it("shows a visible error when both paths fail, then returns to the idle label", async () => {
    setClipboard({ writeText: vi.fn(() => Promise.reject(new Error("denied"))) });
    stubExecCommand(false);
    await clickCopy(block);
    await vi.waitFor(() => expect(container.textContent).toContain("Copy failed"));
    expect(container.textContent).not.toContain("Copied!");
    const button = copyButton();
    expect(button.getAttribute("title")).toMatch(/copy it manually/i);
    expect(button.getAttribute("aria-label")).toMatch(/copy it manually/i);
    expect(button.dataset.copyState).toBe("failed");
    await vi.waitFor(() => expect(container.textContent).not.toContain("Copy failed"), { timeout: 5_000 });
    expect(copyButton().getAttribute("title")).toBe(block === "code" ? "Copy code" : "Copy diagram source");
  });

  it("shows the error rather than doing nothing when there is no API and no execCommand", async () => {
    setClipboard(undefined);
    await clickCopy(block);
    await vi.waitFor(() => expect(container.textContent).toContain("Copy failed"));
  });
});
