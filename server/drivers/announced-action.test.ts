import { describe, expect, it } from "vitest";
import { announcesAction } from "./announced-action.ts";

describe("announced next steps", () => {
  it.each(["reply to: ", "The results are:", "Done —", "Finished..."])("does not continue a reply just because it ends in punctuation: %s", (reply) => {
    expect(announcesAction(reply)).toBe(false);
  });

  it.each(["Checking the page first —", "Now let me run the build.", "I'll read the logs:"])("continues a short announced action: %s", (reply) => {
    expect(announcesAction(reply)).toBe(true);
  });

  it.each(["Now let me run the tests?", "Now let me run the tests. " + "Finished work. ".repeat(40)])("leaves questions and substantial replies alone", (reply) => {
    expect(announcesAction(reply)).toBe(false);
  });
});
