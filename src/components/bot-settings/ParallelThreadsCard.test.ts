import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ globalLimit: undefined as number | undefined }));
vi.mock("@/state/store", () => ({
  useStore: () => ({
    state: { config: { threads: fixture.globalLimit === undefined ? undefined : { maxConcurrentPerBot: fixture.globalLimit } } },
    dispatch: vi.fn(),
  }),
}));

const { ParallelThreadsCard, parallelThreadsPatch } = await import("./ParallelThreadsCard");
const render = (maxConcurrentThreads?: number) =>
  renderToStaticMarkup(createElement(ParallelThreadsCard, { bot: { id: "b1", maxConcurrentThreads } as never }));

describe("ParallelThreadsCard", () => {
  it("offers the live workspace default first, then one through ten", () => {
    fixture.globalLimit = 6;
    const markup = render();
    expect(markup).toContain("Parallel threads");
    expect(markup).toContain('<option value="" selected="">Use default (6)</option>');
    expect(markup.match(/<option /g)).toHaveLength(11);
    expect(markup).toContain('<option value="10">10</option>');
  });

  it("names the built-in default when the config has not loaded a limit", () => {
    fixture.globalLimit = undefined;
    expect(render()).toContain("Use default (3)");
  });

  it("selects the bot's own override", () => {
    fixture.globalLimit = 6;
    const markup = render(2);
    expect(markup).toContain('<option value="2" selected="">2</option>');
    expect(markup).not.toContain('<option value="" selected="">');
  });

  it("saves a chosen number, and null for the default", () => {
    expect(parallelThreadsPatch("4")).toEqual({ maxConcurrentThreads: 4 });
    expect(parallelThreadsPatch("10")).toEqual({ maxConcurrentThreads: 10 });
    expect(parallelThreadsPatch("")).toEqual({ maxConcurrentThreads: null });
  });
});
