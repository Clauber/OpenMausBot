import { it } from "vitest";
import { verifyApprovalRules } from "../scripts/verify-approval-rules.ts";
it("enforces rules, reviews and replay protection through real fixture HTTP and native approval paths", async () => {
  await verifyApprovalRules();
}, 90_000);
