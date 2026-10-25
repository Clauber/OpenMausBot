import { describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { getBaseUrl } from "./setup";

let tabId = "";

describe("POST /tabs/:id/exec", () => {
  beforeAll(async () => {
    const r = await request(getBaseUrl()).post("/tabs").send({
      url: "data:text/html,<div id=x>hello</div>",
      agent: "exec-test",
      persistent: false,
    });
    tabId = r.body.id;
  });
  afterAll(async () => {
    if (tabId) await request(getBaseUrl()).delete(`/tabs/${tabId}`);
  });

  it("returns bare expression value", async () => {
    const res = await request(getBaseUrl())
      .post(`/tabs/${tabId}/exec`)
      .send({ script: "1 + 2" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, result: 3, type: "number" });
  });

  it("returns document title", async () => {
    const res = await request(getBaseUrl())
      .post(`/tabs/${tabId}/exec`)
      .send({ script: "document.querySelector('#x').textContent" });
    expect(res.status).toBe(200);
    expect(res.body.result).toBe("hello");
  });

  it("passes args", async () => {
    const res = await request(getBaseUrl())
      .post(`/tabs/${tabId}/exec`)
      .send({ script: "(a, b) => a * b", args: [6, 7] });
    expect(res.body.result).toBe(42);
  });

  it("thrown error returns ok:false with 200", async () => {
    const res = await request(getBaseUrl())
      .post(`/tabs/${tabId}/exec`)
      .send({ script: "throw new Error('boom')" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain("boom");
  });

  it("timeout enforced", async () => {
    const res = await request(getBaseUrl()).post(`/tabs/${tabId}/exec`).send({
      script: "new Promise(r => setTimeout(r, 5000))",
      timeout: 500,
    });
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain("exec_timeout");
  });

  it("400 on non-string script", async () => {
    const res = await request(getBaseUrl())
      .post(`/tabs/${tabId}/exec`)
      .send({ script: 42 });
    expect(res.status).toBe(400);
  });

  it("404 unknown tab", async () => {
    const res = await request(getBaseUrl())
      .post("/tabs/missing/exec")
      .send({ script: "1" });
    expect(res.status).toBe(404);
  });
});
