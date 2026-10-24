import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { ATTACHMENTS_DIR } from "../attachments.ts";
import type { Viewer } from "../bot-visibility.ts";
import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { Store } from "../store.ts";
import { dispatchRoutes } from "./table.ts";
import { createThreadRoutes, type ThreadRouteDeps } from "./threads.ts";

const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const servers: Server[] = [];
const suite = mkdtempSync(join(tmpdir(), "omb-bot-files-"));
const cwd = join(suite, "project");
const shared = join(suite, "shared");

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(join(cwd, "renders"), { recursive: true });
  mkdirSync(shared, { recursive: true });
  writeFileSync(join(cwd, "renders", "clip.mp4"), "0123456789");
  writeFileSync(join(cwd, "notes.md"), "# notes");
  writeFileSync(join(suite, "secret.txt"), "not in any root");
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});
afterAll(() => rmSync(suite, { recursive: true, force: true }));

async function serve(store: Store, viewer: Viewer = { kind: "all" }): Promise<string> {
  const deps = {
    store,
    userName: () => "Milind",
    viewerFor: () => viewer,
    visibleTo: () => ({ bot: () => true, group: () => true }),
    workspaceAccess: () => null,
    desktopMutationToken: () => undefined,
    companionMutationToken: () => undefined,
    cliOwnerToken: () => undefined,
    messageFileRootsForThread: () => [cwd, shared, ATTACHMENTS_DIR],
  } as unknown as ThreadRouteDeps;
  const routes = [createThreadRoutes(deps)];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const auth = { kind: "loopback", scopes: ["admin"] } as RequestAuth;
      const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
      if (!handled) json(res, 404, { from: "inline routes" });
    } catch (error) {
      json(res, (error as { status?: number }).status ?? 500, { error: String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("GET /api/bots/:id/files", () => {
  it("lists the bot's folders and streams a file, with ranges for seeking", async () => {
    const store = new Store(() => sonnet);
    const bot = store.createBot({ name: "Scout" }, { seedMessages: false });
    const base = await serve(store);

    const top = await (await fetch(`${base}/api/bots/${bot.id}/files`)).json();
    expect(top).toEqual({
      roots: [cwd, shared], root: 0, path: "",
      folders: ["renders"], entries: [{ name: "notes.md", bytes: 7, mime: "text/markdown; charset=utf-8" }], truncated: false,
    });
    const renders = await (await fetch(`${base}/api/bots/${bot.id}/files?path=renders`)).json() as { entries: unknown[] };
    expect(renders.entries).toEqual([{ name: "clip.mp4", bytes: 10, mime: "video/mp4" }]);

    const whole = await fetch(`${base}/api/bots/${bot.id}/files/raw?path=renders/clip.mp4`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("video/mp4");
    expect(whole.headers.get("content-disposition")).toBe("inline");
    expect(await whole.text()).toBe("0123456789");

    const part = await fetch(`${base}/api/bots/${bot.id}/files/raw?path=renders/clip.mp4`, { headers: { range: "bytes=2-4" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(await part.text()).toBe("234");

    const download = await fetch(`${base}/api/bots/${bot.id}/files/raw?path=notes.md&download=1`);
    expect(download.headers.get("content-disposition")).toContain("attachment");
  });

  it("stays inside the chosen root and refuses a team member", async () => {
    const store = new Store(() => sonnet);
    const bot = store.createBot({ name: "Scout" }, { seedMessages: false });
    const base = await serve(store);

    expect((await fetch(`${base}/api/bots/${bot.id}/files/raw?path=../secret.txt`)).status).toBe(400);
    expect((await fetch(`${base}/api/bots/${bot.id}/files?root=2`)).status).toBe(404);
    expect((await fetch(`${base}/api/bots/${bot.id}/files?threadId=someone-else`)).status).toBe(404);
    expect((await fetch(`${base}/api/bots/nobody/files`)).status).toBe(404);

    const memberBase = await serve(store, { kind: "member", email: "member@example.com" });
    expect((await fetch(`${memberBase}/api/bots/${bot.id}/files`)).status).toBe(404);
    expect((await fetch(`${memberBase}/api/bots/${bot.id}/files/raw?path=notes.md`)).status).toBe(404);
  });
});
