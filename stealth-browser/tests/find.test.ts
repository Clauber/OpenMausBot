import { describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { getBaseUrl } from "./setup";

let tabId = "";
const formHtml = `data:text/html,<html><body>
<button>Sign in</button><button>Cancel</button>
<a href="#">Help</a>
</body></html>`;

describe("POST /tabs/:id/find", () => {
  beforeAll(async () => {
    const r = await request(getBaseUrl())
      .post("/tabs")
      .send({ url: formHtml, agent: "find-test", persistent: false });
    tabId = r.body.id;
  });
  afterAll(async () => {
    if (tabId) await request(getBaseUrl()).delete(`/tabs/${tabId}`);
  });

  it("finds button by text + role", async () => {
    const res = await request(getBaseUrl())
      .post(`/tabs/${tabId}/find`)
      .send({ query: "Sign in", role: "button" });
    expect(res.status).toBe(200);
    expect(res.body.matches.length).toBeGreaterThan(0);
    expect(res.body.matches[0]).toMatchObject({ role: "button" });
    expect(res.body.matches[0].ref).toMatch(/^e\d+$/);
  });

  it("returns empty array when no match (200, not 404)", async () => {
    const res = await request(getBaseUrl())
      .post(`/tabs/${tabId}/find`)
      .send({ query: "NonexistentLabel", role: "button" });
    expect(res.status).toBe(200);
    expect(res.body.matches).toEqual([]);
  });

  it("400 on missing query AND role", async () => {
    const res = await request(getBaseUrl())
      .post(`/tabs/${tabId}/find`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_request");
  });

  it("404 for unknown tab", async () => {
    const res = await request(getBaseUrl())
      .post("/tabs/does-not-exist/find")
      .send({ query: "x" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("tab_not_found");
  });
});
