import { describe, expect, it } from "vitest";
import { filePreviewKind, sandboxedHtml } from "./file-preview";

describe("file preview", () => {
  it("picks a renderer from the file name", () => {
    expect(filePreviewKind("/w/recorder-improvement-plan.md")).toBe("markdown");
    expect(filePreviewKind("C:\\w\\report.HTML")).toBe("html");
    expect(filePreviewKind("data.json")).toBe("text");
    expect(filePreviewKind("deck.pptx")).toBe("none");
    expect(filePreviewKind("Makefile")).toBe("none");
  });

  it("puts the page policy in the head, never ahead of the doctype", () => {
    const page = sandboxedHtml("<!doctype html><html><head><script>x()</script></head></html>");
    expect(page.startsWith("<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\"")).toBe(true);
    expect(page.indexOf("connect-src 'none'")).toBeLessThan(page.indexOf("<script>"));
    expect(sandboxedHtml("<!DOCTYPE html><p>hi</p>").startsWith("<!DOCTYPE html><meta")).toBe(true);
    expect(sandboxedHtml("<header>no head</header>").startsWith("<meta")).toBe(true);
  });
});
