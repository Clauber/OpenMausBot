import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolActivity } from "./ToolActivity";

describe("ToolActivity", () => {
  it("starts collapsed with an accessible status and escaped input/output", () => {
    const html = renderToStaticMarkup(createElement(ToolActivity, { tool: { name: "Bash", ok: true, input: "echo hi", output: "<script>unsafe()</script>" } }));
    expect(html).toContain("<details");
    expect(html).not.toContain(" open=");
    expect(html).toContain("Bash · Completed · Tool details");
    expect(html).toContain('role="button"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("echo hi");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
  it("distinguishes pending, failed and unrecorded output", () => {
    const render = (ok?: boolean) => renderToStaticMarkup(createElement(ToolActivity, { tool: { name: "Read", ok } }));
    expect(render()).toContain("Waiting for the tool to finish");
    expect(render(false)).toContain("Failed");
    expect(render(false)).toContain("No output was recorded");
    expect(render(true)).toContain("No output was recorded");
  });
  it("shows the thought before a step as readable text, clamped until opened", () => {
    const html = renderToStaticMarkup(createElement(ToolActivity, { tool: { name: "Bash", ok: true, summary: "ls", thought: "Check what is in <tmp> first." } }));
    expect(html).toContain('data-testid="tool-thought"');
    expect(html).toContain("Check what is in &lt;tmp&gt; first.");
    expect(html).toContain("line-clamp-3");
    expect(html.indexOf("tool-thought")).toBeLessThan(html.indexOf("<details"));
    expect(renderToStaticMarkup(createElement(ToolActivity, { tool: { name: "Bash", ok: true } }))).not.toContain("tool-thought");
  });
});
