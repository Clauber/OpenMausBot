// The skin routes, the way a request reaches them: through the table, on a
// real HTTP server, with a real CustomSkinManager on a temp file behind them.
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { CustomSkinManager } from "../custom-skins.ts";
import { requiredScope } from "../request-auth.ts";
import { createSkinRoutes, type SkinRouteDeps } from "./skins.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function serve(): Promise<{ base: string; events: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), "omb-skin-routes-"));
  dirs.push(dir);
  const events: string[] = [];
  const manager = new CustomSkinManager({ file: join(dir, "custom-skins.json"), emit: (e) => events.push(e.kind) });
  const deps: SkinRouteDeps = { skins: manager };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes([createSkinRoutes(deps)], {
      req, res, url, path: url.pathname, method: req.method ?? "GET",
      auth: { kind: "loopback", scopes: ["admin", "client"] }, json, readBody,
    });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, events };
}

async function call(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

const AMBER = { name: "Ember", mode: "dark", accent: "#d97706" };

describe("skin routes", () => {
  it("every skins route is client-scoped, like routines", () => {
    expect(requiredScope("GET", "/api/skins")).toBe("client");
    expect(requiredScope("POST", "/api/skins")).toBe("client");
    expect(requiredScope("PATCH", "/api/skins/cs-0123abcd")).toBe("client");
    expect(requiredScope("DELETE", "/api/skins/cs-0123abcd")).toBe("client");
    // A wrong id shape is an unknown route, so it stays admin-scoped.
    expect(requiredScope("DELETE", "/api/skins/other")).toBe("admin");
  });

  it("creates, lists, patches and deletes through one manager", async () => {
    const { base, events } = await serve();
    const created = await call(base, "POST", "/api/skins", AMBER);
    expect(created.status).toBe(201);
    const id = created.body.skin.id as string;
    expect(id).toMatch(/^cs-[0-9a-f]{8}$/);
    expect(events).toEqual(["skin"]);

    expect((await call(base, "GET", "/api/skins")).body.skins).toHaveLength(1);

    const patched = await call(base, "PATCH", `/api/skins/${id}`, { name: "Brass" });
    expect(patched.body.skin.name).toBe("Brass");

    expect((await call(base, "DELETE", `/api/skins/${id}`)).status).toBe(200);
    expect((await call(base, "GET", "/api/skins")).body.skins).toHaveLength(0);
    expect((await call(base, "DELETE", `/api/skins/${id}`)).status).toBe(404);
    expect(events).toEqual(["skin", "skin", "skin.deleted"]);
  });

  it("replaces by name on a second POST", async () => {
    const { base } = await serve();
    const first = await call(base, "POST", "/api/skins", AMBER);
    const again = await call(base, "POST", "/api/skins", { ...AMBER, accent: "#f59e0b" });
    expect(again.status).toBe(200);
    expect(again.body.replaced).toBe(true);
    expect(again.body.skin.id).toBe(first.body.skin.id);
  });

  it("reports the manager's fixable validation errors", async () => {
    const { base } = await serve();
    const bad = await call(base, "POST", "/api/skins", { name: "X", mode: "twilight", accent: "#ffffff" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/mode/);
  });

  it("lets other paths through", async () => {
    const { base } = await serve();
    // Only the skin routes are mounted, so "another route" is the fallback's
    // answer — this proves the module declined rather than 404ing itself.
    const response = await fetch(`${base}/api/skins/others/cs-0123abcd`);
    expect(await response.json()).toEqual({ from: "inline routes" });
  });
});
