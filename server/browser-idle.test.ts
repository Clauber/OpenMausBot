import { describe, expect, it } from "vitest";

import { OpenedBrowsers } from "./browser-idle.ts";

describe("OpenedBrowsers", () => {
  const idle = 1_000;

  it("closes and forgets only sessions idle past the limit", async () => {
    const opened = new OpenedBrowsers<string>(idle);
    opened.use("old", "old-spec", 0);
    opened.use("fresh", "fresh-spec", 500);
    const calls: string[] = [];
    expect(await opened.closeIdle(() => false, async (session, spec) => { calls.push(`${session}:${spec}`); }, 1_200)).toEqual(["old"]);
    expect(calls).toEqual(["old:old-spec"]);
    expect(opened.spec("old")).toBeUndefined();
    expect(opened.spec("fresh")).toBe("fresh-spec");
  });

  it("keeps a session that is in use or could not close, and retries it later", async () => {
    const opened = new OpenedBrowsers<string>(idle);
    opened.use("held", "spec", 0);
    opened.use("stuck", "spec", 0);
    expect(await opened.closeIdle((session) => session === "held", async () => { throw new Error("busy"); }, 2_000)).toEqual([]);
    expect(opened.spec("held")).toBe("spec");
    expect(opened.spec("stuck")).toBe("spec");
    expect(await opened.closeIdle(() => false, async () => {}, 2_000)).toEqual(["held", "stuck"]);
  });

  it("keeps a session a tool call re-opened while it was closing", async () => {
    const opened = new OpenedBrowsers<string>(idle);
    opened.use("s", "old", 0);
    await opened.closeIdle(() => false, async () => { opened.use("s", "new", 1_500); }, 1_500);
    expect(opened.spec("s")).toBe("new");
  });
});
