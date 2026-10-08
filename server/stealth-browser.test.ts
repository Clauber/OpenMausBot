import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { StealthAttachments, StealthBrowserError, stealthBrowserCdpUrl } from "./stealth-browser.ts";

let server: Server | null = null;
afterEach(() => new Promise<void>((done) => { if (server) server.close(() => done()); else done(); server = null; }));

function serve(handler: (url: string) => { status: number; body: unknown }): Promise<string> {
  return new Promise((ready) => {
    server = createServer((req, res) => {
      const { status, body } = handler(req.url ?? "");
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    }).listen(0, "127.0.0.1", () => {
      const address = server!.address();
      ready(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`);
    });
  });
}

describe("stealthBrowserCdpUrl", () => {
  it("asks the service for the session's direct-route Chrome and attaches beside the service", async () => {
    const seen: string[] = [];
    const base = await serve((url) => { seen.push(url); return { status: 200, body: { agent: "bot-abc", cdpPort: 9501 } }; });
    await expect(stealthBrowserCdpUrl(base, "bot-abc")).resolves.toBe("http://127.0.0.1:9501");
    expect(seen).toEqual(["/bridge/bot-abc?route=direct"]);
  });

  it("says why when the service fails or answers without a port", async () => {
    const base = await serve((url) => url.startsWith("/bridge/broken")
      ? { status: 500, body: { error: "launch failed" } }
      : { status: 200, body: { hint: "allocated" } });
    await expect(stealthBrowserCdpUrl(base, "broken")).rejects.toThrow("HTTP 500");
    await expect(stealthBrowserCdpUrl(base, "noport")).rejects.toThrow("no CDP port");
    await expect(stealthBrowserCdpUrl("http://127.0.0.1:1", "bot", { timeoutMs: 2_000 })).rejects.toBeInstanceOf(StealthBrowserError);
  });

  it("refuses profile names that could leave the service's profiles directory", async () => {
    for (const session of ["..", "a..b", ".hidden", "a/b", ""]) {
      await expect(stealthBrowserCdpUrl("http://127.0.0.1:9", session)).rejects.toThrow("Invalid stealth browser profile name");
    }
  });
});

describe("StealthAttachments", () => {
  it("keeps a session on its address through a service outage and backs off between retries", async () => {
    let clock = 0;
    let up = true;
    let calls = 0;
    const attachments = new StealthAttachments(async () => { calls++; if (!up) throw new Error("down"); return "http://127.0.0.1:9500"; }, () => clock);
    const warnings: string[] = [];
    expect(await attachments.attachUrl("http://s", "bot-a", (m) => warnings.push(m))).toBe("http://127.0.0.1:9500");
    up = false;
    expect(await attachments.attachUrl("http://s", "bot-a", (m) => warnings.push(m))).toBe("http://127.0.0.1:9500");
    expect(await attachments.attachUrl("http://s", "bot-b", (m) => warnings.push(m))).toBeNull();
    expect(calls).toBe(3);
    clock += 10_000;
    await attachments.attachUrl("http://s", "bot-a", () => {});
    expect(calls).toBe(3); // still backing off
    clock += 30_000;
    up = true;
    expect(await attachments.attachUrl("http://s", "bot-b", () => {})).toBe("http://127.0.0.1:9500");
    expect(calls).toBe(4);
    expect(warnings).toHaveLength(2);
  });
});
