import { describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { getBaseUrl } from "./setup";

let tabId = "";

describe("POST /tabs/:id/mouse", () => {
  beforeAll(async () => {
    const r = await request(getBaseUrl()).post("/tabs").send({
      url: `data:text/html,<div style="height:5000px"><button id=b style="position:absolute;top:200px;left:200px">B</button></div>`,
      agent: "mouse-test",
      persistent: false,
    });
    tabId = r.body.id;
  });
  afterAll(async () => {
    if (tabId) await request(getBaseUrl()).delete(`/tabs/${tabId}`);
  });

  it("click", async () => {
    const res = await request(getBaseUrl())
      .post(`/tabs/${tabId}/mouse`)
      .send({ action: "click", x: 220, y: 220 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("move", async () => {
    const res = await request(getBaseUrl())
      .post(`/tabs/${tabId}/mouse`)
      .send({ action: "move", x: 100, y: 100 });
    expect(res.status).toBe(200);
  });

  it("scrollTo", async () => {
    const res = await request(getBaseUrl())
      .post(`/tabs/${tabId}/mouse`)
      .send({ action: "scrollTo", y: 1000 });
    expect(res.status).toBe(200);
  });

  it("hover", async () => {
    const res = await request(getBaseUrl())
      .post(`/tabs/${tabId}/mouse`)
      .send({ action: "hover", x: 50, y: 50 });
    expect(res.status).toBe(200);
  });

  it("400 on unknown action", async () => {
    const res = await request(getBaseUrl())
      .post(`/tabs/${tabId}/mouse`)
      .send({ action: "teleport" });
    expect(res.status).toBe(400);
  });

  it("404 unknown tab", async () => {
    const res = await request(getBaseUrl())
      .post("/tabs/none/mouse")
      .send({ action: "click", x: 0, y: 0 });
    expect(res.status).toBe(404);
  });
});
