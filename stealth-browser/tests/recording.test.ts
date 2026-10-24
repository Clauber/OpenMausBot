import { describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { getBaseUrl } from "./setup";

let tabId = "";

describe("recording", () => {
  beforeAll(async () => {
    const r = await request(getBaseUrl()).post("/tabs").send({
      url: `data:text/html,<div id=x style="background:red;width:200px;height:200px"></div>`,
      agent: "rec-test",
      persistent: false,
    });
    tabId = r.body.id;
  });
  afterAll(async () => {
    if (tabId) await request(getBaseUrl()).delete(`/tabs/${tabId}`);
  });

  it("start → record 2s → stop returns gif path + frames", async () => {
    const start = await request(getBaseUrl())
      .post(`/tabs/${tabId}/recording/start`)
      .send({ fps: 5, maxDurationMs: 10_000 });
    expect(start.status).toBe(200);
    const recId = start.body.recordingId;
    expect(recId).toBeTruthy();

    await new Promise((r) => setTimeout(r, 2000));

    const stop = await request(getBaseUrl())
      .post(`/tabs/${tabId}/recording/stop`)
      .send({ recordingId: recId });
    expect(stop.status).toBe(200);
    expect(stop.body.ok).toBe(true);
    expect(typeof stop.body.path).toBe("string");
    expect(typeof stop.body.sizeBytes).toBe("number");
  }, 20_000);

  it("409 if start while one already running", async () => {
    const a = await request(getBaseUrl())
      .post(`/tabs/${tabId}/recording/start`)
      .send({ fps: 5, maxDurationMs: 10_000 });
    expect(a.status).toBe(200);
    const b = await request(getBaseUrl())
      .post(`/tabs/${tabId}/recording/start`)
      .send({ fps: 5 });
    expect(b.status).toBe(409);
    await request(getBaseUrl())
      .post(`/tabs/${tabId}/recording/stop`)
      .send({ recordingId: a.body.recordingId });
  }, 15_000);

  it("404 stop with wrong id", async () => {
    const res = await request(getBaseUrl())
      .post(`/tabs/${tabId}/recording/stop`)
      .send({ recordingId: "nope" });
    expect(res.status).toBe(404);
  });
});
