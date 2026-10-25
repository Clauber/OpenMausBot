import { describe, expect, it } from "vitest";
import { continueNumberedList } from "./composer-lists";

describe("continueNumberedList", () => {
  it("continues with the next number", () => {
    expect(continueNumberedList("1. first", 8)).toEqual({ text: "1. first\n2. ", caret: 12 });
    expect(continueNumberedList("intro\n9) ninth", 14)).toEqual({ text: "intro\n9) ninth\n10) ", caret: 19 });
  });

  it("keeps the indent and splits mid-item text", () => {
    expect(continueNumberedList("  3. ab", 6)).toEqual({ text: "  3. a\n  4. b", caret: 12 });
  });

  it("ends the list on an empty item", () => {
    expect(continueNumberedList("1. first\n2. ", 12)).toEqual({ text: "1. first\n", caret: 9 });
  });

  it("ignores lines that are not list items or a caret inside the marker", () => {
    expect(continueNumberedList("hello", 5)).toBeNull();
    expect(continueNumberedList("2026 was", 8)).toBeNull();
    expect(continueNumberedList("1.5 kg", 6)).toBeNull();
    expect(continueNumberedList("1. first", 1)).toBeNull();
  });
});
