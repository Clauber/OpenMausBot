import { describe, expect, it } from "vitest";
import { masterPermissionSchema } from "./master-permissions.ts";
import { fleetOwner } from "./routes/fleet.ts";

describe("master permission boundaries", () => {
  it("rejects mixed scope, injected fields, and Custom across all threads", () => {
    expect(masterPermissionSchema.safeParse({ targetBotId: "pam", approvalMode: "custom", applyToAllThreads: true }).success).toBe(false);
    expect(masterPermissionSchema.safeParse({ targetBotId: "pam", approvalMode: "full", threadId: "foreign" }).success).toBe(false);
    expect(masterPermissionSchema.parse({ targetBotId: "pam", approvalMode: "full" }).applyToAllThreads).toBe(false);
  });

  it("does not treat a bot shell or service as owner assignment authority", () => {
    expect(fleetOwner({ kind: "loopback", scopes: ["admin", "client"] }, false)).toBe(false);
    expect(fleetOwner({ kind: "loopback", trust: "service", scopes: ["client"] }, true)).toBe(false);
    expect(fleetOwner({ kind: "loopback", scopes: ["admin", "client"] }, true)).toBe(true);
  });
});
