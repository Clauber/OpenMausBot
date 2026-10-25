import { describe, expect, it } from "vitest";
import request from "supertest";
import { getBaseUrl } from "./setup";

describe("cookies endpoints (backfill)", () => {
  const agent = "cookie-test-agent";

  it("POST /profiles/:agent/cookies injects cookies", async () => {
    const res = await request(getBaseUrl())
      .post(`/profiles/${agent}/cookies`)
      .send({
        cookies: [
          {
            name: "session",
            value: "abc123",
            domain: "example.com",
            path: "/",
          },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, agent });
  });

  it("GET /profiles/:agent/cookies exports", async () => {
    const res = await request(getBaseUrl()).get(
      `/profiles/${agent}/cookies?domain=example.com`,
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.cookies)).toBe(true);
  });
});
