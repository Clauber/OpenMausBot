import { describe, expect, it } from "vitest";

import { isTransientZcodeFailure, zcodeFailureReason, zcodeResumeDelayMs } from "./zcode-turn-recovery.ts";

describe("isTransientZcodeFailure", () => {
  it("accepts zcode's own network, server and timeout classifications", () => {
    for (const reason of ["network_error", "server_error", "timeout", "stream_idle_timeout"]) {
      expect(isTransientZcodeFailure({ attribution: { reason } }), reason).toBe(true);
    }
  });

  it("falls back to the error code when there is no attribution", () => {
    expect(isTransientZcodeFailure({ code: "model_network_error" })).toBe(true);
    expect(isTransientZcodeFailure({ code: "model_request_failed" })).toBe(false);
  });

  it("does not retry refusals, quota or rate limits", () => {
    expect(isTransientZcodeFailure({ attribution: { reason: "unauthorized", statusCode: 401 } })).toBe(false);
    expect(isTransientZcodeFailure({ attribution: { reason: "rate_limited" } })).toBe(false);
    expect(isTransientZcodeFailure({ attribution: { reason: "network_error", statusCode: 400 } })).toBe(false);
    expect(isTransientZcodeFailure({ message: "quota exceeded" })).toBe(false);
    expect(isTransientZcodeFailure(undefined)).toBe(false);
  });

  it("still retries a request timeout and a gateway error", () => {
    expect(isTransientZcodeFailure({ attribution: { reason: "timeout", statusCode: 408 } })).toBe(true);
    expect(isTransientZcodeFailure({ attribution: { reason: "server_error", statusCode: 502 } })).toBe(true);
  });
});

describe("zcodeResumeDelayMs", () => {
  it("backs off and stays at the last delay", () => {
    expect([1, 2, 3, 4, 5, 6].map(zcodeResumeDelayMs)).toEqual([2000, 5000, 10000, 20000, 30000, 30000]);
    expect(zcodeResumeDelayMs(0)).toBe(2000);
  });
});

describe("zcodeFailureReason", () => {
  it("reads zcode's attribution reason only", () => {
    expect(zcodeFailureReason({ attribution: { reason: "network_error" } })).toBe("network_error");
    expect(zcodeFailureReason({ code: "model_network_error" })).toBeUndefined();
    expect(zcodeFailureReason(null)).toBeUndefined();
  });
});
