import { describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { getBaseUrl } from "./setup";

let tabId = "";

describe("tabs lifecycle (existing endpoints backfill)", () => {
  beforeAll(async () => {
    const r = await request(getBaseUrl()).post("/tabs").send({
      url: "data:text/html,<title>LT</title><h1>hi</h1>",
      agent: "lifecycle",
      persistent: false,
    });
    expect(r.status).toBe(201);
    tabId = r.body.id;
  });
  afterAll(async () => {
    if (tabId) await request(getBaseUrl()).delete(`/tabs/${tabId}`);
  });

  it("POST /tabs 400 on missing url", async () => {
    const res = await request(getBaseUrl()).post("/tabs").send({});
    expect(res.status).toBe(400);
  });

  it("GET /tabs/:id/snapshot aria default", async () => {
    const res = await request(getBaseUrl()).get(`/tabs/${tabId}/snapshot`);
    expect(res.status).toBe(200);
    expect(typeof res.body.snapshot).toBe("string");
    expect(res.body.format).toBe("aria");
  });

  it("GET /tabs/:id/snapshot text", async () => {
    const res = await request(getBaseUrl()).get(
      `/tabs/${tabId}/snapshot?format=text`,
    );
    expect(res.status).toBe(200);
    expect(res.body.snapshot).toContain("hi");
  });

  it("GET /tabs/:id/screenshot returns base64", async () => {
    const res = await request(getBaseUrl()).get(`/tabs/${tabId}/screenshot`);
    expect(res.status).toBe(200);
    expect(typeof res.body.screenshot).toBe("string");
    expect(res.body.screenshot.length).toBeGreaterThan(100);
  });

  it("POST /tabs/:id/navigate 400 on missing url", async () => {
    const res = await request(getBaseUrl())
      .post(`/tabs/${tabId}/navigate`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("DELETE /tabs/:id 404 for unknown", async () => {
    const res = await request(getBaseUrl()).delete(`/tabs/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it("GET /tabs/:id/snapshot 404 for unknown", async () => {
    const res = await request(getBaseUrl()).get(`/tabs/missing/snapshot`);
    expect(res.status).toBe(404);
  });
});
