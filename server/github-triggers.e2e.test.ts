import { expect, it } from "vitest";
import { verifyGithubTriggers } from "../scripts/verify-github-triggers.ts";

it("verifies signed routine deliveries through isolated HTTP ingress and the fake engine", async () => {
  const { evidence } = await verifyGithubTriggers();
  expect(evidence.ok).toBe(true);
  expect(Object.keys(evidence.cases)).toEqual(["a", "b", "c", "d", "e"]);
  expect(evidence.cleanup).toBe(true);
}, 120_000);
