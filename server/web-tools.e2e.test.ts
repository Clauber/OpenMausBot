import { it } from "vitest";
import { verifyWebTools } from "../scripts/verify-web-tools.ts";
it("fetches, guards and searches through the real harness and a loopback fake web", async () => {
  await verifyWebTools();
}, 180_000);
