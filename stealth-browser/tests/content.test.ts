import { describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { getBaseUrl } from "./setup";

let tabId = "";

describe("content endpoints (backfill)", () => {
  beforeAll(async () => {
    const r = await request(getBaseUrl()).post("/tabs").send({
      url: "data:text/html,<title>Doc</title><h1>Heading</h1><p>Body text here.</p>",
      agent: "content-test",
      persistent: false,
    });
    tabId = r.body.id;
  });
  afterAll(async () => {
    if (tabId) await request(getBaseUrl()).delete(`/tabs/${tabId}`);
  });

  it("read_page returns title + content", async () => {
    const res = await request(getBaseUrl()).get(`/tabs/${tabId}/read_page`);
    expect(res.status).toBe(200);
    expect(typeof res.body.title).toBe("string");
    expect(typeof res.body.content).toBe("string");
    expect(typeof res.body.wordCount).toBe("number");
  });

  it("read_page 404 unknown tab", async () => {
    const res = await request(getBaseUrl()).get(`/tabs/missing/read_page`);
    expect(res.status).toBe(404);
  });

  it("fill_form 404 unknown tab", async () => {
    const res = await request(getBaseUrl())
      .post(`/tabs/missing/fill_form`)
      .send({ fields: [] });
    expect(res.status).toBe(404);
  });
});

describe("fill_form human typing (default on)", () => {
  let formTabId = "";
  beforeAll(async () => {
    const r = await request(getBaseUrl())
      .post("/tabs")
      .send({
        url:
          "data:text/html," +
          encodeURIComponent(`<form onsubmit="return false">
            <label>Email <input name="email" id="email" /></label>
            <label>Password <input name="password" id="password" type="password" /></label>
          </form>`),
        agent: "fill-human-test",
        persistent: false,
      });
    formTabId = r.body.id;
  });
  afterAll(async () => {
    if (formTabId) await request(getBaseUrl()).delete(`/tabs/${formTabId}`);
  });

  it("human path types value into input", async () => {
    const res = await request(getBaseUrl())
      .post(`/tabs/${formTabId}/fill_form`)
      .send({
        fields: [{ label: "Email", value: "alice@example.com" }],
      });
    expect(res.status).toBe(200);
    expect(res.body.filled).toBe(1);

    // Verify via exec
    const val = await request(getBaseUrl())
      .post(`/tabs/${formTabId}/exec`)
      .send({ script: "document.querySelector('#email').value" });
    expect(val.body.result).toBe("alice@example.com");
  }, 15_000);

  it("human:false uses fast fill", async () => {
    const res = await request(getBaseUrl())
      .post(`/tabs/${formTabId}/fill_form`)
      .send({
        fields: [{ label: "Password", value: "s3cret!", human: false }],
      });
    expect(res.status).toBe(200);
    expect(res.body.filled).toBe(1);

    const val = await request(getBaseUrl())
      .post(`/tabs/${formTabId}/exec`)
      .send({ script: "document.querySelector('#password').value" });
    expect(val.body.result).toBe("s3cret!");
  });

  it("human path clears existing value before typing", async () => {
    // Email field has "alice@example.com" from first test
    const res = await request(getBaseUrl())
      .post(`/tabs/${formTabId}/fill_form`)
      .send({
        fields: [{ label: "Email", value: "bob@test.io" }],
      });
    expect(res.status).toBe(200);

    const val = await request(getBaseUrl())
      .post(`/tabs/${formTabId}/exec`)
      .send({ script: "document.querySelector('#email').value" });
    expect(val.body.result).toBe("bob@test.io");
  }, 15_000);
});
