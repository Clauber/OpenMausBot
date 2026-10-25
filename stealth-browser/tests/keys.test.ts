import { describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { getBaseUrl } from "./setup";

let tabId = "";

describe("POST /tabs/:id/keys", () => {
  beforeAll(async () => {
    const r = await request(getBaseUrl()).post("/tabs").send({
      url: `data:text/html,<input id="x" />`,
      agent: "keys-test",
      persistent: false,
    });
    tabId = r.body.id;
    await request(getBaseUrl())
      .post(`/tabs/${tabId}/click`)
      .send({ selector: "#x" });
  });
  afterAll(async () => {
    if (tabId) await request(getBaseUrl()).delete(`/tabs/${tabId}`);
  });

  it("presses Enter", async () => {
    const res = await request(getBaseUrl())
      .post(`/tabs/${tabId}/keys`)
      .send({ keys: "Enter" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, keys: "Enter" });
  });

  it("presses Control+A combo", async () => {
    const res = await request(getBaseUrl())
      .post(`/tabs/${tabId}/keys`)
      .send({ keys: "Control+A" });
    expect(res.status).toBe(200);
  });

  it("translates Cmd+ to Meta+", async () => {
    const res = await request(getBaseUrl())
      .post(`/tabs/${tabId}/keys`)
      .send({ keys: "Cmd+A" });
    expect(res.status).toBe(200);
    expect(res.body.keys).toBe("Meta+A");
  });

  it("400 on blocked combo Control+W", async () => {
    const res = await request(getBaseUrl())
      .post(`/tabs/${tabId}/keys`)
      .send({ keys: "Control+W" });
    expect(res.status).toBe(400);
  });

  it("400 on unknown key syntax", async () => {
    const res = await request(getBaseUrl())
      .post(`/tabs/${tabId}/keys`)
      .send({ keys: "NotAKey###" });
    expect(res.status).toBe(400);
  });

  it("404 for unknown tab", async () => {
    const res = await request(getBaseUrl())
      .post("/tabs/missing/keys")
      .send({ keys: "Enter" });
    expect(res.status).toBe(404);
  });
});
