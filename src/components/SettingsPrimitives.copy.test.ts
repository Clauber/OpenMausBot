// @vitest-environment happy-dom
// CommandLine's copy button goes through the shared clipboard helper: it works
// without navigator.clipboard, and a total failure is visible instead of silent.
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandLine } from "./SettingsPrimitives";
import { setLocale } from "@/lib/i18n";

const COMMAND = "npm install -g @example/cli";
const setClipboard = (value: unknown) => Object.defineProperty(navigator, "clipboard", { value, configurable: true });
const stubExecCommand = (result: boolean) => {
  const copied: string[] = [];
  Object.defineProperty(document, "execCommand", {
    value: vi.fn(() => { copied.push(document.querySelector("textarea")?.value ?? ""); return result; }),
    configurable: true,
  });
  return copied;
};

let root: Root;
let container: HTMLElement;
const copyButton = () => container.querySelector<HTMLButtonElement>("button[aria-label]")!;
const clickCopy = async () => {
  root.render(createElement(CommandLine, { command: COMMAND }));
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
});

describe("CommandLine copy", () => {
  it("copies through the Clipboard API and shows the success icon", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    setClipboard({ writeText });
    await clickCopy();
    await vi.waitFor(() => expect(container.querySelector(".lucide-check")).not.toBeNull());
    expect(writeText).toHaveBeenCalledWith(COMMAND);
  });

  it("copies through the textarea fallback when navigator.clipboard is missing", async () => {
    setClipboard(undefined);
    const copied = stubExecCommand(true);
    await clickCopy();
    await vi.waitFor(() => expect(container.querySelector(".lucide-check")).not.toBeNull());
    expect(copied).toEqual([COMMAND]);
  });

  it("shows a visible error state when both paths fail", async () => {
    setClipboard({ writeText: () => Promise.reject(new Error("denied")) });
    stubExecCommand(false);
    await clickCopy();
    await vi.waitFor(() => expect(copyButton().dataset.copyState).toBe("failed"));
    expect(container.querySelector(".lucide-check")).toBeNull();
    expect(copyButton().getAttribute("aria-label")).toMatch(/copy it manually/i);
    expect(container.querySelector("[role=status]")?.textContent).toMatch(/copy failed/i);
  });
});
