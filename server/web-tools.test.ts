import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactsDb } from "./artifacts-db.ts";
import { guardedGet, isPrivateAddress, setWebNetworkForTests, WebFetchError } from "./web-ssrf.ts";
import { clearWebCache, htmlToText, parseDuckDuckGoHtml, webFetch } from "./web-tools.ts";

afterEach(() => {
  setWebNetworkForTests(null);
  clearWebCache();
});

describe("isPrivateAddress", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1", "::ffff:7f00:1"])("refuses %s", (a) => {
    expect(isPrivateAddress(a)).toBe(true);
  });
  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111"])("allows %s", (a) => {
    expect(isPrivateAddress(a)).toBe(false);
  });
});

describe("DNS rebinding", () => {
  it("refuses a public-looking hostname that resolves to a private address", async () => {
    setWebNetworkForTests({ lookup: ((_host: string, _opts: unknown, cb: (e: null, a: unknown[]) => void) => cb(null, [{ address: "10.0.0.5", family: 4 }])) as never });
    await expect(guardedGet("http://rebind.example.test/")).rejects.toMatchObject({ code: "private" });
  });
  it("refuses when any one of several answers is private", async () => {
    setWebNetworkForTests({ lookup: ((_h: string, _o: unknown, cb: (e: null, a: unknown[]) => void) => cb(null, [{ address: "93.184.216.34", family: 4 }, { address: "192.168.0.9", family: 4 }])) as never });
    await expect(guardedGet("http://mixed.example.test/")).rejects.toBeInstanceOf(WebFetchError);
  });
});

describe("web_fetch against a loopback fake", () => {
  it("strips tags, caps at 30k and caches", async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits++;
      res.setHeader("content-type", "text/html");
      res.end(`<title>T</title><script>x()</script><p>${"a".repeat(40_000)}</p>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    setWebNetworkForTests({ allowAddress: (a) => a === "127.0.0.1" });
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
      const first = await webFetch(url);
      expect(first).toMatchObject({ title: "T", truncated: true, cached: false });
      expect(first.text).toHaveLength(30_000);
      expect((await webFetch(url)).cached).toBe(true);
      expect(hits).toBe(1);
    } finally {
      server.close();
    }
  });
});

describe("parsing", () => {
  it("htmlToText drops scripts and decodes entities", () => {
    expect(htmlToText("<title>A &amp; B</title><style>x{}</style><p>Hi&nbsp;<i>there</i></p><script>no()</script>"))
      .toEqual({ title: "A & B", text: "Hi there" });
  });
  it("parseDuckDuckGoHtml unwraps redirect links and caps at the limit", () => {
    const row = (n: number) => `<a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(`https://e.com/${n}`)}">T${n}</a><a class="result__snippet">S${n}</a>`;
    const hits = parseDuckDuckGoHtml(Array.from({ length: 12 }, (_, i) => row(i)).join(""));
    expect(hits).toHaveLength(8);
    expect(hits[1]).toEqual({ title: "T1", url: "https://e.com/1", snippet: "S1" });
  });
});

describe("ArtifactsDb", () => {
  it("versions a rewritten path per thread and lists the latest of each", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifacts-db-"));
    const db = new ArtifactsDb(join(dir, "a.sqlite"));
    try {
      const base = { botId: "b", mime: "text/csv", size: 1, blob: "x" };
      const v1 = db.add({ ...base, threadId: "t1", path: "r.csv", name: "r.csv" });
      const v2 = db.add({ ...base, threadId: "t1", path: "r.csv", name: "r.csv" });
      db.add({ ...base, threadId: "t2", path: "r.csv", name: "r.csv" });
      expect([v1.version, v2.version]).toEqual([1, 2]);
      expect(db.listLatest("t1").map((a) => a.version)).toEqual([2]);
      expect(db.versions(v1.id).map((a) => a.version)).toEqual([1, 2]);
      expect(db.listLatest("t2")).toHaveLength(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
