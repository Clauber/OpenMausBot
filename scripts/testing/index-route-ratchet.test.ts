// New HTTP routes go in server/routes (server/routes/README.md), yet
// server/index.ts kept gaining inline `if (path === ...)` blocks. This counts
// the three ways index.ts matches a request path and holds each count at or
// below the number written here. The numbers only go down: when a PR moves a
// route out of index.ts, it lowers them in the same PR. A new route never
// raises them; it goes in server/routes instead.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const INDEX = readFileSync(new URL("../../server/index.ts", import.meta.url), "utf8");

// Counted per occurrence, so a second path added to an existing `||` guard
// counts too. startsWith is counted so a prefix guard cannot stand in for a route.
const MOST: Record<string, number> = {
  'path === "/': 164,
  "path.match(": 91,
  "path.startsWith(": 11,
};

const count = (needle: string) => INDEX.split(needle).length - 1;

describe("server/index.ts gains no route handlers", () => {
  it("matches request paths no more often than before", () => {
    const grown = Object.entries(MOST)
      .filter(([needle, most]) => count(needle) > most)
      .map(([needle, most]) => `${needle} appears ${count(needle)} times, at most ${most}`);
    expect(grown, "Put new routes in server/routes (server/routes/README.md), not server/index.ts.").toEqual([]);
  });
});
