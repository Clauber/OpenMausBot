import { describe, expect, it, vi } from "vitest";
import { sendTabNotFound, sendBadRequest, sendInternal } from "../src/errors";

function mockRes() {
  const res: any = { statusCode: 0, body: null };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body: any) => {
    res.body = body;
    return res;
  });
  return res;
}

describe("error helpers", () => {
  it("sendTabNotFound returns 404 with structured body", () => {
    const res = mockRes();
    sendTabNotFound(res, "abc-123");
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "tab_not_found", id: "abc-123" });
  });

  it("sendBadRequest returns 400 with reason", () => {
    const res = mockRes();
    sendBadRequest(res, "missing field: url");
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: "bad_request",
      reason: "missing field: url",
    });
  });

  it("sendInternal returns 500 with message", () => {
    const res = mockRes();
    sendInternal(res, "boom");
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "internal", message: "boom" });
  });
});
