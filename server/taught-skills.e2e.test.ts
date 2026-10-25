import { expect, it } from "vitest";
import { verifyTaughtSkills } from "../scripts/verify-taught-skills.ts";

it("records, approves, replays and stops taught skills through isolated server and fake MCP fixtures", async () => {
  expect(await verifyTaughtSkills()).toEqual({ a: true, b: true, c: true, d: true });
}, 90_000);
