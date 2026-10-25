import { it } from "vitest";
import { verifyArtifacts } from "../scripts/verify-artifacts.ts";
it("registers bot-attached files as versioned thread artifacts through the real harness", async () => {
  await verifyArtifacts();
}, 120_000);
