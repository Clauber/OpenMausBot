import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TeachingSessions } from "./teaching-session.ts";
import { BrowserClient } from "./browser-runtime.ts";
import { gatedLocalComputer } from "./local-computer.ts";

describe("recording through the existing computer MCP bridge", () => {
  it("captures driver calls and their results before returning them, while keeping discovery lease-free", async () => {
    const root = mkdtempSync(join(tmpdir(), "teach-bridge-"));
    const sessions = new TeachingSessions(root);
    const computer = { id: "host", kind: "local", approvalMode: "ask" as const, close: async () => {}, call: async () => ({ content: [] }) };
    sessions.start("bot", "thread", computer, "Bridge demo");
    let finish: ((result: unknown) => void) | undefined;
    const phases: string[] = [];
    const server = createServer((req, res) => {
      void (async () => {
        expect(req.headers.authorization).toBe("Bearer fixture-teach-token");
        let raw = ""; for await (const chunk of req) raw += chunk;
        let body: unknown = { held: false };
        if (req.url === "/api/internal/teach-capture") {
          const request = JSON.parse(raw); phases.push(request.phase);
          if (request.phase === "begin") {
            finish = sessions.begin("bot", "thread", "host", request.tool, request.args);
            body = { captureId: "capture" };
          } else { finish?.(request.result); body = { ok: true }; }
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
      })();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const driver = `const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const frame=JSON.parse(line);if(frame.id===undefined)return;process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:frame.id,result:frame.method==='initialize'?{protocolVersion:'2025-06-18'}:frame.method==='tools/list'?{tools:[]}:{content:[{type:'text',text:'ok'}]}})+'\\n');});`;
    const connection = gatedLocalComputer({ command: process.execPath, args: ["-e", driver], env: {}, platform: "linux", scope: "local-computer" },
      { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/control`, token: "fixture-teach-token" });
    const client = new BrowserClient(connection, 5000, 10_000, 1, () => {}, () => {});
    try {
      await client.ready; await client.rpc("tools/list", {}); expect(phases).toEqual([]);
      for (const name of ["navigate", "click", "type"]) {
        await client.rpc("tools/call", { name, arguments: {} });
        expect(sessions.current("bot", "thread")?.pending).toBe(0);
      }
      expect(phases).toEqual(["begin", "finish", "begin", "finish", "begin", "finish"]);
      expect(sessions.stop("bot", "thread").steps.map(step => step.action)).toEqual(["navigate", "click", "type"]);
    } finally { await client.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true }); }
  });
});
