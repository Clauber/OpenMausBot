import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { getBaseUrl } from "./setup";

async function closeAll() {
  const listing = await request(getBaseUrl()).get("/tabs");
  for (const t of listing.body?.tabs ?? []) {
    await request(getBaseUrl()).delete(`/tabs/${t.id}`);
  }
}

describe("GET /tabs", () => {
  beforeEach(closeAll);

  it("returns empty list when no tabs", async () => {
    const res = await request(getBaseUrl()).get("/tabs");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ count: 0, tabs: [] });
    expect(typeof res.body.maxTabs).toBe("number");
  });

  it("lists open tabs with id, agent, route, url, title, persistent, timestamps", async () => {
    const create = await request(getBaseUrl()).post("/tabs").send({
      url: "data:text/html,<title>T1</title><h1>x</h1>",
      agent: "list-alpha",
      persistent: false,
    });
    expect(create.status).toBe(201);
    const id = create.body.id;

    const res = await request(getBaseUrl()).get("/tabs");
    expect(res.body.count).toBe(1);
    const t = res.body.tabs[0];
    expect(t.id).toBe(id);
    expect(t.agent).toBe("list-alpha");
    expect(t.title).toBe("T1");
    expect(typeof t.createdAt).toBe("string");
    expect(typeof t.lastUsedAt).toBe("string");
    expect(typeof t.persistent).toBe("boolean");
  });

  it("filters by agent query param", async () => {
    const a = await request(getBaseUrl())
      .post("/tabs")
      .send({ url: "data:text/html,a", agent: "list-a", persistent: false });
    await request(getBaseUrl())
      .post("/tabs")
      .send({ url: "data:text/html,b", agent: "list-b", persistent: false });
    const res = await request(getBaseUrl()).get("/tabs?agent=list-a");
    expect(res.body.count).toBe(1);
    expect(res.body.tabs[0].id).toBe(a.body.id);
  });
});
