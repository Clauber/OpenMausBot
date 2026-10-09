import { describe, expect, it } from "vitest";
import { userTextIsMarkdown } from "./user-message-markdown";

describe("userTextIsMarkdown", () => {
  it("keeps plain messages plain", () => {
    expect(userTextIsMarkdown("")).toBe(false);
    expect(userTextIsMarkdown("hello there")).toBe(false);
    expect(userTextIsMarkdown("snake_case and 2 * 3 * 4 and **not bold**")).toBe(false);
    expect(userTextIsMarkdown("first line\nsecond line\n\nthird line")).toBe(false);
    expect(userTextIsMarkdown("see #QA PR 245 for details\nthanks")).toBe(false);
    expect(userTextIsMarkdown("price is 3.50 now\nok")).toBe(false);
  });

  it("never switches a single line, even one that looks like a marker", () => {
    expect(userTextIsMarkdown("# Heading")).toBe(false);
    expect(userTextIsMarkdown("- item")).toBe(false);
    expect(userTextIsMarkdown("1. item")).toBe(false);
    expect(userTextIsMarkdown("  - item  \n")).toBe(false);
  });

  it("switches a multi-line message that has a heading, list, fence, quote or table", () => {
    expect(userTextIsMarkdown("# Task\nDo the thing")).toBe(true);
    expect(userTextIsMarkdown("Intro\n\n## Steps\ntext")).toBe(true);
    expect(userTextIsMarkdown("Todo:\n- one\n- two")).toBe(true);
    expect(userTextIsMarkdown("Todo:\n* one")).toBe(true);
    expect(userTextIsMarkdown("Todo:\n1. one\n2. two")).toBe(true);
    expect(userTextIsMarkdown("Run:\n```sh\nls\n```")).toBe(true);
    expect(userTextIsMarkdown("Run:\n~~~\nls\n~~~")).toBe(true);
    expect(userTextIsMarkdown("He said\n> quoted")).toBe(true);
    expect(userTextIsMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |")).toBe(true);
  });

  it("does not treat a #thread reference, a bare hash or a dash without a space as a marker", () => {
    expect(userTextIsMarkdown("#QA PR 245\nplease")).toBe(false);
    expect(userTextIsMarkdown("#\nplease")).toBe(false);
    expect(userTextIsMarkdown("-5 degrees\nbrr")).toBe(false);
    expect(userTextIsMarkdown("####### seven\nx")).toBe(false);
  });
});
