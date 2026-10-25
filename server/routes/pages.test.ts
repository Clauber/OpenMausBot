import { expect, it } from "vitest";
import { verifyPages } from "../../scripts/verify-pages.ts";

it("authenticates Pages HTTP routes and verifies revision conflicts, limits, reviewed dedupe, transcript saving and page chat in an isolated fixture", async () => {
  const result = await verifyPages();
  expect(result.checks).toContain("engine context");
  console.info(JSON.stringify(result));
}, 90_000);
