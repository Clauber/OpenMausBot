import { describe, expect, it } from "vitest";
import request from "supertest";
import { getBaseUrl } from "./setup";

describe("GET /health", () => {
  it("returns status, tabs, maxTabs", async () => {
    const res = await request(getBaseUrl()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok" });
    expect(typeof res.body.tabs).toBe("number");
    expect(typeof res.body.maxTabs).toBe("number");
  });
});
