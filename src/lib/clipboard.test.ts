// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

const setClipboard = (value: unknown) =>
  Object.defineProperty(navigator, "clipboard", { value, configurable: true });

/** Replace execCommand with a spy that records the textarea it ran against. */
const stubExecCommand = (result: boolean | Error) => {
  const seen: { value: string; connected: boolean }[] = [];
  const exec = vi.fn((command: string) => {
    const area = document.querySelector("textarea");
    seen.push({ value: area?.value ?? "", connected: Boolean(area?.isConnected) });
    if (result instanceof Error) throw result;
    return command === "copy" && result;
  });
  Object.defineProperty(document, "execCommand", { value: exec, configurable: true });
  return { exec, seen };
};

afterEach(() => {
  setClipboard(undefined);
  Reflect.deleteProperty(document, "execCommand");
  document.body.innerHTML = "";
});

describe("copyText", () => {
  it("uses the async Clipboard API when it is present and reports success", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    setClipboard({ writeText });
    const { exec } = stubExecCommand(true);
    await expect(copyText("https://example.com/a")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("https://example.com/a");
    expect(exec).not.toHaveBeenCalled();
  });

  it("falls back to a hidden textarea and execCommand when the API is missing", async () => {
    setClipboard(undefined);
    const { exec, seen } = stubExecCommand(true);
    await expect(copyText("one line")).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
    expect(seen).toEqual([{ value: "one line", connected: true }]);
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("falls back when writeText rejects (permission denied / unfocused document)", async () => {
    const writeText = vi.fn(() => Promise.reject(new DOMException("denied", "NotAllowedError")));
    setClipboard({ writeText });
    const { exec, seen } = stubExecCommand(true);
    await expect(copyText("fallback me")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledOnce();
    expect(exec).toHaveBeenCalledWith("copy");
    expect(seen[0]?.value).toBe("fallback me");
  });

  it("falls back when writeText throws synchronously", async () => {
    setClipboard({ writeText: () => { throw new Error("boom"); } });
    stubExecCommand(true);
    await expect(copyText("x")).resolves.toBe(true);
  });

  it("reports failure without throwing when both paths fail", async () => {
    setClipboard({ writeText: () => Promise.reject(new Error("denied")) });
    stubExecCommand(false);
    await expect(copyText("nope")).resolves.toBe(false);
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("reports failure when execCommand throws or does not exist", async () => {
    setClipboard(undefined);
    stubExecCommand(new Error("not allowed"));
    await expect(copyText("nope")).resolves.toBe(false);
    Reflect.deleteProperty(document, "execCommand");
    Object.defineProperty(document, "execCommand", { value: undefined, configurable: true });
    await expect(copyText("nope")).resolves.toBe(false);
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("returns focus to the control that was focused before the fallback ran", async () => {
    setClipboard(undefined);
    stubExecCommand(true);
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();
    await copyText("x");
    expect(document.activeElement).toBe(button);
  });
});
