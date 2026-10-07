import { describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { getBaseUrl } from "./setup";

let tabId = "";

// type="button" on submit avoids navigation when clicked
const html = `data:text/html,<form onsubmit="return false">
<input name="email" id="email" />
<input type="checkbox" id="rem" />
<select id="role"><option>a</option><option>b</option></select>
<button type="button" id="go">Go</button>
</form>`;

describe("interaction endpoints (backfill)", () => {
  beforeAll(async () => {
    const r = await request(getBaseUrl())
      .post("/tabs")
      .send({ url: html, agent: "inter-test", persistent: false });
    tabId = r.body.id;
  });
  afterAll(async () => {
    if (tabId) await request(getBaseUrl()).delete(`/tabs/${tabId}`);
  });

  it("click by selector", async () => {
    const res = await request(getBaseUrl())
      .post(`/tabs/${tabId}/click`)
      .send({ selector: "#go" });
    expect(res.status).toBe(200);
  });

  it("type into input", async () => {
    const res = await request(getBaseUrl())
      .post(`/tabs/${tabId}/type`)
      .send({ selector: "#email", text: "a@b.com" });
    expect(res.status).toBe(200);
  });

  it("check toggle", async () => {
    const res = await request(getBaseUrl())
      .post(`/tabs/${tabId}/check`)
      .send({ selector: "#rem", checked: true });
    expect(res.status).toBe(200);
  });

  it("select option", async () => {
    const res = await request(getBaseUrl())
      .post(`/tabs/${tabId}/select`)
      .send({ selector: "#role", option: "b" });
    expect(res.status).toBe(200);
  });

  it("scroll down", async () => {
    const res = await request(getBaseUrl())
      .post(`/tabs/${tabId}/scroll`)
      .send({ direction: "down", amount: 100 });
    expect(res.status).toBe(200);
  });

  it("404 click unknown tab", async () => {
    const res = await request(getBaseUrl())
      .post(`/tabs/missing/click`)
      .send({ selector: "#x" });
    expect(res.status).toBe(404);
  });
});
