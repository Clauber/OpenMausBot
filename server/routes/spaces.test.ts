import { expect, it } from "vitest";
import { verifySpaces } from "../../scripts/verify-spaces.ts";

it("enforces space isolation over the real HTTP route table in an isolated fixture", async () => {
  const result = await verifySpaces();
  expect(result.checks).toContain("403 space_isolation");
  console.info(JSON.stringify(result));
}, 120_000);
