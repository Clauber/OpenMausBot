import { describe, expect, it, afterAll } from "vitest";
import request from "supertest";
import { getBaseUrl } from "./setup";

describe("stale-tab GC sweep", () => {
  const createdIds: string[] = [];

  afterAll(async () => {
    for (const id of createdIds) {
      await request(getBaseUrl()).delete(`/tabs/${id}`);
    }
    // Also drain anything lingering
    const listing = await request(getBaseUrl()).get("/tabs");
    for (const t of listing.body.tabs ?? []) {
      await request(getBaseUrl()).delete(`/tabs/${t.id}`);
    }
  });

  it("closes an idle tab when MAX_TABS hit (with short STALE_TAB_MS)", async () => {
    // Drain existing tabs first
    const initial = await request(getBaseUrl()).get("/tabs");
    for (const t of initial.body.tabs ?? []) {
      await request(getBaseUrl()).delete(`/tabs/${t.id}`);
    }

    // Temporarily override: the route reads STALE_TAB_MS on every request, so
    // set via process.env at test time. This test depends on MAX_TABS=5.
    process.env.STALE_TAB_MS = "500";

    // Create MAX_TABS (5) tabs
    for (let i = 0; i < 5; i++) {
      const r = await request(getBaseUrl())
        .post("/tabs")
        .send({
          url: "data:text/html,<h1>t" + i + "</h1>",
          agent: "stale-" + i,
          persistent: false,
        });
      expect(r.status).toBe(201);
      createdIds.push(r.body.id);
    }

    // Wait for all to exceed STALE_TAB_MS
    await new Promise((r) => setTimeout(r, 800));

    // Creating a 6th should GC an idle tab and succeed
    const sixth = await request(getBaseUrl()).post("/tabs").send({
      url: "data:text/html,<h1>sixth</h1>",
      agent: "stale-6",
      persistent: false,
    });
    expect(sixth.status).toBe(201);
    createdIds.push(sixth.body.id);

    const listing = await request(getBaseUrl()).get("/tabs");
    expect(listing.body.count).toBeLessThanOrEqual(5);

    delete process.env.STALE_TAB_MS;
  }, 30_000);
});
