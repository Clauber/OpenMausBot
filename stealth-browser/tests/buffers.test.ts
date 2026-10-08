import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import request from "supertest";
import { getBaseUrl } from "./setup";

const consoleHtml = readFileSync(
  join(__dirname, "fixtures/console-noisy.html"),
  "utf8",
);
const consoleDataUrl =
  "data:text/html;base64," + Buffer.from(consoleHtml).toString("base64");

describe("GET /tabs/:id/console", () => {
  let tabId = "";
  beforeAll(async () => {
    const r = await request(getBaseUrl())
      .post("/tabs")
      .send({ url: consoleDataUrl, agent: "console-test", persistent: false });
    tabId = r.body.id;
    await new Promise((r) => setTimeout(r, 500));
  });
  afterAll(async () => {
    if (tabId) await request(getBaseUrl()).delete(`/tabs/${tabId}`);
  });

  it("returns markdown table by default", async () => {
    const res = await request(getBaseUrl()).get(`/tabs/${tabId}/console`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("| time");
    expect(res.text).toContain("error #0");
  });

  it("format=json returns JSON entries", async () => {
    const res = await request(getBaseUrl()).get(
      `/tabs/${tabId}/console?format=json`,
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(res.body.entries.length).toBeGreaterThan(0);
    expect(res.body.entries[0]).toHaveProperty("level");
  });

  it("filters by level=error", async () => {
    const res = await request(getBaseUrl()).get(
      `/tabs/${tabId}/console?format=json&level=error`,
    );
    for (const e of res.body.entries) expect(e.level).toBe("error");
  });

  it("400 on bad regex", async () => {
    const res = await request(getBaseUrl()).get(
      `/tabs/${tabId}/console?pattern=%5B`,
    );
    expect(res.status).toBe(400);
  });

  it("clear=true drains buffer after returning data", async () => {
    const before = await request(getBaseUrl()).get(
      `/tabs/${tabId}/console?format=json&clear=true`,
    );
    expect(before.body.entries.length).toBeGreaterThan(0);
    const after = await request(getBaseUrl()).get(
      `/tabs/${tabId}/console?format=json`,
    );
    expect(after.body.entries.length).toBe(0);
  });

  it("404 unknown tab", async () => {
    const res = await request(getBaseUrl()).get(`/tabs/missing/console`);
    expect(res.status).toBe(404);
  });
});

describe("GET /tabs/:id/network", () => {
  let tabId = "";
  beforeAll(async () => {
    const r = await request(getBaseUrl()).post("/tabs").send({
      url: "data:text/html,<h1>net</h1>",
      agent: "net-test",
      persistent: false,
    });
    tabId = r.body.id;
  });
  afterAll(async () => {
    if (tabId) await request(getBaseUrl()).delete(`/tabs/${tabId}`);
  });

  it("returns empty markdown when no network activity (200)", async () => {
    const res = await request(getBaseUrl()).get(`/tabs/${tabId}/network`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("| time | method");
  });

  it("format=json returns entries array (may be empty)", async () => {
    const res = await request(getBaseUrl()).get(
      `/tabs/${tabId}/network?format=json`,
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
  });

  it("body=true sets deferred header", async () => {
    const res = await request(getBaseUrl()).get(
      `/tabs/${tabId}/network?body=true`,
    );
    expect(res.status).toBe(200);
    expect(res.headers["x-stealth-body-capture"]).toBe("deferred-to-v2");
  });

  it("404 unknown tab", async () => {
    const res = await request(getBaseUrl()).get(`/tabs/missing/network`);
    expect(res.status).toBe(404);
  });
});
