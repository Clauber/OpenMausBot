import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";
import { createPageSchema } from "./testing/oversized-tool-schema.ts";
import { schemaBytes, TOOL_SCHEMA_PROFILE_ENV } from "./tool-schema-profile.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, "mcp-gate.ts");

/** Answers tools/call with whatever its script says and echoes anything else, to prove pass-through. */
const UPSTREAM = `
const { createInterface } = require("node:readline");
const { readFileSync } = require("node:fs");
const reply = JSON.parse(readFileSync(process.env.SCRIPT, "utf8"));
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "tools/call") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: reply }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { echoed: msg.method, params: msg.params ?? null } }) + "\\n");
});
`;

const SCOPED_UPSTREAM = `
const { createInterface } = require("node:readline");
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const script = JSON.parse(readFileSync(process.env.SCRIPT, "utf8"));
writeFileSync(process.env.SCRIPT + ".started", "started");
let delayedList;
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
const catalog = (params) => params?.cursor === "second"
  ? { tools: [{ name: "write", inputSchema: { type: "object" } }] }
  : { tools: [{ name: "read", inputSchema: { type: "object" } }, { name: "write", inputSchema: { type: "object" } }], nextCursor: "second" };
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "tools/list") {
    if (script.malformedFrame) return process.stdout.write("not-json\\n");
    if (script.malformedCatalog) return send(msg.id, { tools: [{ inputSchema: { type: "object" } }] });
    if (msg.params?.collision) { delayedList = msg; return; }
    return send(msg.id, catalog(msg.params));
  }
  if (msg.method === "tools/call") {
    appendFileSync(process.env.SCRIPT + ".calls", msg.params.name + "\\n");
    send(msg.id, { content: [{ type: "text", text: script.text ?? "executed" }] });
    if (delayedList) { send(delayedList.id, catalog()); delayedList = undefined; }
    return;
  }
  send(msg.id, { scope: process.env.OMB_GATE_TOOL_SCOPE ?? null, upstreamOnly: process.env.UPSTREAM_ONLY });
});
`;

const DISCOVERY_UPSTREAM = `
const { createInterface } = require("node:readline");
const { appendFileSync, readFileSync } = require("node:fs");
const script = JSON.parse(readFileSync(process.env.SCRIPT, "utf8"));
let waitingCall;
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  appendFileSync(process.env.SCRIPT + ".frames", line + "\\n");
  const send = (body) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...body }) + "\\n");
  if (msg.method === "tools/list") {
    if (script.malformed) return send({ result: { tools: [{ name: "secret_bad" }] } });
    if (script.repeated) return send({ result: { tools: [], nextCursor: "same" } });
    if (script.rpcError) return send({ error: { code: -32001, message: "catalog unavailable" } });
    const offset = Number(msg.params?.cursor ?? 0);
    return send({ result: { tools: Array.from({ length: 100 }, (_, i) => ({
      name: "tool_" + (offset + i), description: "Fixture search " + "x".repeat(4000),
      inputSchema: { type: "object", properties: { value: { type: "string" } } }
    })), ...(offset < 200 ? { nextCursor: String(offset + 100) } : {}) } });
  }
  if (msg.method === "notifications/cancelled") {
    if (waitingCall?.id === msg.params.requestId) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: waitingCall.id, error: { code: -32800, message: "cancelled" } }) + "\\n");
    return;
  }
  if (msg.method === "tools/call" && msg.params.arguments?.wait) { waitingCall = msg; return; }
  if (msg.method === "tools/call" && msg.params.arguments?.rpcError) return send({ error: { code: -32001, message: "fixture", data: { preserved: true } } });
  if (msg.method === "tools/call") return send({ result: { content: [{ type: "text", text: "done" }], structuredContent: msg.params, isError: !!msg.params.arguments?.toolError, _meta: { preserved: true } } });
  send({ result: msg.params });
});
`;

/** Answers tools/list with its script as the catalog. */
const LISTING_UPSTREAM = `
const { createInterface } = require("node:readline");
const { readFileSync } = require("node:fs");
const catalog = JSON.parse(readFileSync(process.env.SCRIPT, "utf8"));
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: msg.method === "tools/list" ? catalog : {} }) + "\\n");
});
`;

describe("mcp-gate", () => {
  let scratch: string;
  let gate: ChildProcessWithoutNullStreams | undefined;
  let lines: string[];
  let waiting: Array<(line: string) => void>;

  const start = (reply: unknown, env: Record<string, string> = {}, source = UPSTREAM, args: string[] = []) => {
    const script = join(scratch, "reply.json");
    writeFileSync(script, JSON.stringify(reply));
    const upstreamJs = join(scratch, "upstream.cjs");
    writeFileSync(upstreamJs, source);
    gate = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", GATE, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        OMB_GATE_NAME: "shop",
        OMB_GATE_SPILL_DIR: join(scratch, "spill"),
        OMB_GATE_UPSTREAM: JSON.stringify({
          command: process.execPath,
          args: [upstreamJs],
          env: { SCRIPT: script, UPSTREAM_ONLY: "yes" },
        }),
        ...env,
      },
    }) as ChildProcessWithoutNullStreams;
    createInterface({ input: gate.stdout }).on("line", (line) => {
      const next = waiting.shift();
      if (next) next(line);
      else lines.push(line);
    });
  };

  const nextLine = (): Promise<string> =>
    new Promise((resolve, reject) => {
      const buffered = lines.shift();
      if (buffered !== undefined) return resolve(buffered);
      const timer = setTimeout(() => reject(new Error("no frame from the gate")), 15_000);
      const closed = () => {
        clearTimeout(timer);
        reject(new Error("gate closed before replying"));
      };
      gate!.once("close", closed);
      waiting.push((line) => {
        clearTimeout(timer);
        gate!.off("close", closed);
        resolve(line);
      });
    });

  const send = (message: unknown) => gate!.stdin.write(`${JSON.stringify(message)}\n`);

  const call = async (name: string, id = 1) => {
    send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } });
    return JSON.parse(await nextLine());
  };

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "omb-gate-test-"));
    lines = [];
    waiting = [];
  });

  afterEach(async () => {
    if (gate && gate.exitCode === null && gate.signalCode === null) {
      const closed = once(gate, "close");
      gate.kill();
      await closed;
    }
    gate = undefined;
    await removeTempDir(scratch);
  });

  it("discovers a large paginated catalog without advertising its schemas", async () => {
    start({}, { OMB_GATE_DISCOVERY: "1", OMB_GATE_BUDGET: "0" }, DISCOVERY_UPSTREAM);
    send({ jsonrpc: "2.0", id: "list", method: "tools/list" });
    const listing = JSON.parse(await nextLine());
    expect(listing.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["search_tools", "call_tool"]);
    expect(JSON.stringify(listing).length).toBeLessThan(2500);
    expect(listing.result.tools[1].annotations.readOnlyHint).toBe(false);
    const request = (id: number, name: string, args: unknown) => send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, _meta: { progressToken: "progress" } } });
    request(2, "search_tools", { query: "tool_299" });
    const found = JSON.parse(JSON.parse(await nextLine()).result.content[0].text);
    expect(found.tools[0].name).toBe("tool_299");
    expect(found.tools[0].description.length).toBeGreaterThan(4000);
    request(3, "search_tools", { query: "fixture" });
    const first = JSON.parse(JSON.parse(await nextLine()).result.content[0].text);
    expect(first.tools).toHaveLength(3);
    expect(first.nextCursor).toBeDefined();
    request(4, "search_tools", { query: "fixture", cursor: first.nextCursor });
    const second = JSON.parse(JSON.parse(await nextLine()).result.content[0].text);
    expect(second.tools).toHaveLength(3);
    expect(second.tools[0].name).not.toBe(first.tools[0].name);
    for (const [id, name, args] of [[5, "call_tool", { name: "tool_299", arguments: { toolError: true } }], [6, "tool_299", { toolError: true }]] as const) {
      request(id, name, args);
      expect(JSON.parse(await nextLine()).result).toEqual({ content: [{ type: "text", text: "done" }], structuredContent: { name: "tool_299", arguments: { toolError: true }, _meta: { progressToken: "progress" } }, isError: true, _meta: { preserved: true } });
    }
    request(7, "call_tool", { name: "tool_299", arguments: { rpcError: true } });
    expect(JSON.parse(await nextLine()).error).toEqual({ code: -32001, message: "fixture", data: { preserved: true } });
    const frames = readFileSync(join(scratch, "reply.json.frames"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(frames.filter(frame => frame.method === "tools/list").map(frame => frame.params?.cursor)).toEqual([undefined, "100", "200"]);
  });

  it("withholds excluded schemas and rejects both direct and discovered calls", async () => {
    start({}, { OMB_GATE_DISCOVERY: "1", OMB_GATE_BUDGET: "0", OMB_GATE_TOOL_SCOPE: JSON.stringify({ allow: ["mcp:shop:tool_299"] }) }, DISCOVERY_UPSTREAM);
    send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    await nextLine();
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_tools", arguments: { query: "" } } });
    const found = JSON.parse(JSON.parse(await nextLine()).result.content[0].text);
    expect(found.tools.map((tool: { name: string }) => tool.name)).toEqual(["tool_299"]);
    for (const params of [{ name: "tool_1", arguments: {} }, { name: "call_tool", arguments: { name: "tool_1", arguments: {} } }]) {
      send({ jsonrpc: "2.0", id: 3, method: "tools/call", params });
      expect(JSON.parse(await nextLine()).error.code).toBe(-32602);
    }
    const frames = readFileSync(join(scratch, "reply.json.frames"), "utf8");
    expect(frames).not.toContain('"method":"tools/call"');
  });

  it.each([{ malformed: true }, { repeated: true }, { rpcError: true }])("rejects unusable discovery catalogs without exposing partial schemas %j", async script => {
    start(script, { OMB_GATE_DISCOVERY: "1" }, DISCOVERY_UPSTREAM);
    send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const reply = JSON.parse(await nextLine());
    expect(reply.error).toBeDefined();
    expect(reply.result).toBeUndefined();
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_tools", arguments: { query: "" } } });
    expect(JSON.parse(await nextLine()).error).toBeDefined();
    const frames = readFileSync(join(scratch, "reply.json.frames"), "utf8").trim().split("\n");
    expect(frames.length).toBeLessThanOrEqual(2);
  });

  it("preserves cancellation IDs and non-tool RPC through discovery", async () => {
    start({}, { OMB_GATE_DISCOVERY: "1" }, DISCOVERY_UPSTREAM);
    send({ jsonrpc: "2.0", id: "pending", method: "tools/call", params: { name: "call_tool", arguments: { name: "tool_299", arguments: { wait: true } }, _meta: { progressToken: 4 } } });
    send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "pending", reason: "fixture cancellation" } });
    expect(JSON.parse(await nextLine())).toEqual({ jsonrpc: "2.0", id: "pending", error: { code: -32800, message: "cancelled" } });
    for (const method of ["resources/read", "prompts/get"]) {
      const params = { name: "fixture", _meta: { progressToken: "meta" } };
      send({ jsonrpc: "2.0", id: 2, method, params });
      expect(JSON.parse(await nextLine())).toEqual({ jsonrpc: "2.0", id: 2, result: params });
    }
    const frames = readFileSync(join(scratch, "reply.json.frames"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(frames[0]).toMatchObject({ id: "pending", params: { name: "tool_299", arguments: { wait: true }, _meta: { progressToken: 4 } } });
    expect(frames[1]).toEqual({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "pending", reason: "fixture cancellation" } });
  });

  it("loads private discovery configuration without requiring a tool scope", async () => {
    const key = `OMB_GATE_CONFIG_${"a".repeat(64)}`;
    const privateConfig = {
      OMB_GATE_NAME: "shop", OMB_GATE_DISCOVERY: "1", OMB_GATE_BUDGET: "0",
      OMB_GATE_UPSTREAM: JSON.stringify({ command: process.execPath, args: [join(scratch, "upstream.cjs")], env: { SCRIPT: join(scratch, "reply.json") } }),
    };
    start({}, { [key]: JSON.stringify(privateConfig) }, DISCOVERY_UPSTREAM, ["--config-env", key]);
    send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(JSON.parse(await nextLine()).result.tools).toHaveLength(2);
  });

  it.each(["true", "0", ""])("fails closed on a malformed discovery flag %s", async flag => {
    start({}, { OMB_GATE_DISCOVERY: flag }, SCOPED_UPSTREAM);
    expect((await once(gate!, "close"))[0]).toBe(1);
    expect(existsSync(join(scratch, "reply.json.started"))).toBe(false);
  });

  it("relays a frame that is not a tool result untouched", async () => {
    start({ content: [{ type: "text", text: "ok" }] });
    send({ jsonrpc: "2.0", id: 7, method: "tools/list" });
    expect(JSON.parse(await nextLine())).toEqual({ jsonrpc: "2.0", id: 7, result: { echoed: "tools/list", params: null } });
  });

  it.each([undefined, "not-json", "{}", '{"OMB_GATE_NAME":"notes","OMB_GATE_TOOL_SCOPE":"{}"}'])("refuses missing or corrupt private gate settings before spawning upstream: %s", value => {
    const key = `OMB_GATE_CONFIG_${"a".repeat(64)}`;
    start({}, value === undefined ? {} : { [key]: value }, SCOPED_UPSTREAM, ["--config-env", key]);
    return once(gate!, "close").then(([code]) => {
      expect(code).toBe(1);
      expect(existsSync(join(scratch, "reply.json.started"))).toBe(false);
    });
  });

  it("leaves a small tool result exactly as the server sent it", async () => {
    const result = { content: [{ type: "text", text: JSON.stringify({ cart: { total: 131 } }) }] };
    start(result);
    expect((await call("get_food_cart")).result).toEqual(result);
    expect(existsSync(join(scratch, "spill"))).toBe(false);
  });

  it("trims an oversized result and saves the whole thing for the bot to read", async () => {
    const products = Array.from({ length: 300 }, (_, i) => ({ id: `p${i}`, name: `Bar ${i}`, blurb: "x".repeat(300) }));
    const full = JSON.stringify({ nextOffset: "1", products });
    start({ content: [{ type: "text", text: full }] });

    const answer = await call("search_products");
    const text = answer.result.content[0].text;
    expect(text.length).toBeLessThan(full.length / 10);
    expect(text.startsWith("⚠️ SHAPED by Legion:")).toBe(true);

    const spillDir = join(scratch, "spill");
    const [file] = readdirSync(spillDir);
    expect(file).toContain("search_products");
    expect(readFileSync(join(spillDir, file), "utf8")).toBe(full);
    expect(text).not.toContain(join(spillDir, file));

    const kept = JSON.parse(text.slice(text.indexOf("\n\n") + 2, text.lastIndexOf("\n\n⚠️")));
    expect(kept.products[0]).toEqual(products[0]);
    expect(kept.nextOffset).toBe("1");
  });

  it("trims structuredContent alongside the text it duplicates", async () => {
    const products = Array.from({ length: 300 }, (_, i) => ({ id: `p${i}`, blurb: "x".repeat(300) }));
    start({
      content: [{ type: "text", text: JSON.stringify({ products }) }],
      structuredContent: { products },
    });

    const answer = await call("search_products");
    expect(answer.result.structuredContent.products.length).toBeLessThan(300);
    expect(answer.result.structuredContent.products[0]).toEqual(products[0]);
    // the same records as the text, so the two copies never disagree
    const text: string = answer.result.content[0].text;
    const kept = JSON.parse(text.slice(text.indexOf("\n\n") + 2, text.lastIndexOf("\n\n⚠️")));
    expect(answer.result.structuredContent).toEqual(kept);
  });

  it("matches structuredContent to the text whatever its key order", async () => {
    const products = Array.from({ length: 300 }, (_, i) => ({ id: `p${i}`, blurb: "x".repeat(300) }));
    start({
      content: [{ type: "text", text: JSON.stringify({ products, meta: "x" }) }],
      structuredContent: { meta: "x", products },
    });

    const answer = await call("search_products");
    const text: string = answer.result.content[0].text;
    const kept = JSON.parse(text.slice(text.indexOf("\n\n") + 2, text.lastIndexOf("\n\n⚠️")));
    expect(answer.result.structuredContent).toEqual(kept);
  });

  it("honours a budget the harness sets", async () => {
    const products = Array.from({ length: 300 }, (_, i) => ({ id: `p${i}`, blurb: "x".repeat(300) }));
    start({ content: [{ type: "text", text: JSON.stringify({ products }) }], structuredContent: undefined }, { OMB_GATE_BUDGET: "2000" });
    const text = (await call("search_products")).result.content[0].text;
    expect(text.length).toBeLessThan(2_400);
  });

  it("keeps the upstream server's own environment and hides the gate's", async () => {
    start({ content: [{ type: "text", text: "ok" }] });
    send({ jsonrpc: "2.0", id: 3, method: "peek" });
    await nextLine();
    // The upstream started at all, so it read SCRIPT from the env the gate passed through.
    expect(JSON.parse(JSON.stringify(process.env.OMB_GATE_UPSTREAM ?? null))).toBe(null);
  });

  it("spawns an upstream named as a bare command on PATH", async () => {
    // `npx -y mcp-remote ...` is an npm shim on Windows, which CreateProcess cannot exec directly.
    const script = join(scratch, "reply.json");
    writeFileSync(script, JSON.stringify({ content: [{ type: "text", text: "ok" }] }));
    const upstreamJs = join(scratch, "upstream.cjs");
    writeFileSync(upstreamJs, UPSTREAM);
    gate = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", GATE], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        OMB_GATE_NAME: "shop",
        OMB_GATE_UPSTREAM: JSON.stringify({ command: "node", args: [upstreamJs], env: { SCRIPT: script } }),
      },
    }) as ChildProcessWithoutNullStreams;
    createInterface({ input: gate.stdout }).on("line", (line) => {
      const next = waiting.shift();
      if (next) next(line);
      else lines.push(line);
    });

    expect((await call("get_food_cart")).result).toEqual({ content: [{ type: "text", text: "ok" }] });
  });

  it("relays a result whole when it is a shape the trimmer cannot cut", async () => {
    start({ someOtherShape: "z".repeat(40_000) });
    const answer = await call("weird_tool");
    expect(answer.result.someOtherShape.length).toBe(40_000);
  });

  const selected = { OMB_GATE_TOOL_SCOPE: JSON.stringify({ allow: ["mcp:shop:read"] }), OMB_GATE_BUDGET: "0" };

  it("filters each catalog page and rejects a withheld call before upstream execution", async () => {
    start({}, selected, SCOPED_UPSTREAM);
    send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(JSON.parse(await nextLine())).toEqual({ jsonrpc: "2.0", id: 1, result: {
      tools: [{ name: "read", inputSchema: { type: "object" } }], nextCursor: "second",
    } });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { cursor: "second" } });
    expect(JSON.parse(await nextLine()).result).toEqual({ tools: [] });
    expect((await call("write", 3)).error).toMatchObject({ code: -32602 });
    expect(existsSync(join(scratch, "reply.json.calls"))).toBe(false);
    expect((await call("read", 4)).result.content[0].text).toBe("executed");
    expect(readFileSync(join(scratch, "reply.json.calls"), "utf8")).toBe("read\n");
  });

  it("keeps numeric and string IDs separate when list and call answers arrive out of order", async () => {
    start({}, selected, SCOPED_UPSTREAM);
    send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { collision: true } });
    send({ jsonrpc: "2.0", id: "1", method: "tools/call", params: { name: "read", arguments: {} } });
    expect(JSON.parse(await nextLine())).toMatchObject({ id: "1", result: { content: [{ text: "executed" }] } });
    expect(JSON.parse(await nextLine())).toMatchObject({ id: 1, result: { tools: [{ name: "read" }] } });
  });

  it("enforces deny precedence without trimming when the result budget is zero", async () => {
    const text = "z".repeat(40_000);
    start({ text }, { OMB_GATE_BUDGET: "0", OMB_GATE_TOOL_SCOPE: JSON.stringify({ allow: ["mcp:shop:*"], deny: ["mcp:shop:write"] }) }, SCOPED_UPSTREAM);
    expect((await call("write")).error).toMatchObject({ code: -32602 });
    expect((await call("read", 2)).result.content[0].text).toBe(text);
    expect(existsSync(join(scratch, "spill"))).toBe(false);
  });

  it.each(["{", "null", '{"allow":null}'])("exits on invalid scope %s before starting the upstream", async (scope) => {
    start({}, { OMB_GATE_TOOL_SCOPE: scope }, SCOPED_UPSTREAM);
    const closed = once(gate!, "close");
    gate!.stdin.end();
    const [code] = await closed;
    expect(code).toBe(1);
    expect(existsSync(join(scratch, "reply.json.started"))).toBe(false);
    expect(lines).toEqual([]);
  });

  it("never exposes malformed tool definitions in a restricted connection", async () => {
    start({ malformedCatalog: true }, selected, SCOPED_UPSTREAM);
    send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const reply = JSON.parse(await nextLine());
    expect(reply.error).toMatchObject({ code: -32603 });
    expect(reply.result).toBeUndefined();
  });

  it("closes a restricted connection instead of forwarding an unreadable upstream frame", async () => {
    start({ malformedFrame: true }, selected, SCOPED_UPSTREAM);
    const closed = once(gate!, "close");
    send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    gate!.stdin.end();
    expect((await closed)[0]).toBe(1);
    expect(lines).toEqual([]);
  });

  it("rejects invalid call parameters and unreadable client frames locally", async () => {
    start({}, selected, SCOPED_UPSTREAM);
    send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: ["read"] } });
    expect(JSON.parse(await nextLine()).error).toMatchObject({ code: -32602 });
    gate!.stdin.write("not-json\n");
    expect(JSON.parse(await nextLine()).error).toMatchObject({ code: -32700 });
    expect(existsSync(join(scratch, "reply.json.calls"))).toBe(false);
  });

  // Lists the directory's three names beside a plain tool and answers every call with a long text, recording what it ran.
  const DIRECTORY_UPSTREAM = `
const { createInterface } = require("node:readline");
const { appendFileSync } = require("node:fs");
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "tools/list") return send(msg.id, { tools: ["search_tools", "describe_tool", "call_tool", "read"].map((name) => ({ name, inputSchema: { type: "object" } })) });
  if (msg.method === "tools/call") {
    appendFileSync(process.env.SCRIPT + ".calls", JSON.stringify(msg.params) + "\\n");
    return send(msg.id, { content: [{ type: "text", text: "d".repeat(4_000) }] });
  }
  send(msg.id, {});
});
`;
  const ran = () => existsSync(join(scratch, "reply.json.calls"))
    ? readFileSync(join(scratch, "reply.json.calls"), "utf8").trim().split("\n").map((line) => JSON.parse(line).name as string) : [];
  const callWith = async (name: string, args: unknown, id: number) => {
    send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    return JSON.parse(await nextLine());
  };

  it("checks call_tool against the tool it runs only when its upstream is the tool directory", async () => {
    const scope = { OMB_GATE_TOOL_SCOPE: JSON.stringify({ allow: ["mcp:shop:read"] }), OMB_GATE_BUDGET: "600" };
    start({}, { ...scope, OMB_GATE_DIRECTORY: "1" }, DIRECTORY_UPSTREAM);
    send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(JSON.parse(await nextLine()).result.tools.map((tool: { name: string }) => tool.name)).toEqual(["search_tools", "describe_tool", "call_tool", "read", "query_result"]);
    expect((await callWith("call_tool", { name: "write", arguments: {} }, 2)).error).toMatchObject({ code: -32602 });
    expect(ran()).toEqual([]);
    expect((await callWith("describe_tool", { name: "read" }, 3)).result.content[0].text).toHaveLength(4_000);
    expect((await callWith("call_tool", { arguments: {} }, 4)).result.content[0].text).toHaveLength(4_000);
    expect((await callWith("call_tool", { name: "read", arguments: {} }, 5)).result.content[0].text).toContain("TRUNCATED by Legion");
    expect(ran()).toEqual(["describe_tool", "call_tool", "call_tool"]);
  });

  it("treats those names as ordinary tools for any other upstream", async () => {
    start({}, { OMB_GATE_TOOL_SCOPE: JSON.stringify({ allow: ["mcp:shop:read"] }), OMB_GATE_BUDGET: "600" }, DIRECTORY_UPSTREAM);
    send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(JSON.parse(await nextLine()).result.tools.map((tool: { name: string }) => tool.name)).toEqual(["read", "query_result"]);
    expect((await callWith("call_tool", { name: "read", arguments: {} }, 2)).error).toMatchObject({ code: -32602 });
    expect((await callWith("describe_tool", { name: "read" }, 3)).error).toMatchObject({ code: -32602 });
    expect(ran()).toEqual([]);
  });

  it("fits each listed schema to the engine's provider profile, and lists tools as they came without one", async () => {
    const catalog = { tools: [{ name: "small", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
      { name: "create_page", description: "Create a page.", inputSchema: createPageSchema() }] };
    start(catalog, { OMB_GATE_BUDGET: "0", [TOOL_SCHEMA_PROFILE_ENV]: "moonshot" }, LISTING_UPSTREAM);
    send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const [small, page] = JSON.parse(await nextLine()).result.tools;
    expect(small).toEqual(catalog.tools[0]);
    expect(schemaBytes(page.inputSchema)).toBeLessThanOrEqual(12_000);
    expect(page.description).toMatch(/^Create a page\.\n\n\(Legion shortened this tool's parameters to fit Kimi's size limit/);
    gate!.kill();
    await once(gate!, "close");

    start(catalog, { OMB_GATE_BUDGET: "0" }, LISTING_UPSTREAM);
    send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(JSON.parse(await nextLine()).result).toEqual(catalog);
  });

  describe("shaping an oversized result", () => {
    const products = Array.from({ length: 300 }, (_, i) => ({ id: `p${i}`, name: `Bar ${i}`, price: 100 + i, blurb: "x".repeat(300) }));
    const full = JSON.stringify({ nextOffset: "1", products });
    const query = async (args: unknown, id: number) => {
      send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "query_result", arguments: args } });
      return JSON.parse(await nextLine());
    };

    it("lists query_result beside the server's tools only while it trims", async () => {
      start({ text: full }, {}, SCOPED_UPSTREAM);
      send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      const first = JSON.parse(await nextLine()).result;
      expect(first.tools.map((tool: { name: string }) => tool.name)).toEqual(["read", "write"]);
      send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { cursor: "second" } });
      const last = JSON.parse(await nextLine()).result;
      expect(last.tools.map((tool: { name: string }) => tool.name)).toEqual(["write", "query_result"]);
      expect(last.tools[1].annotations.readOnlyHint).toBe(true);
    });

    it("never lists it when the budget is zero", async () => {
      start({ text: full }, { OMB_GATE_BUDGET: "0" }, SCOPED_UPSTREAM);
      send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { cursor: "second" } });
      expect(JSON.parse(await nextLine()).result.tools.map((tool: { name: string }) => tool.name)).toEqual(["write"]);
    });

    it("holds the whole result and answers a query locally with just the selection", async () => {
      start({ text: full }, {}, SCOPED_UPSTREAM);
      const shaped: string = (await call("read")).result.content[0].text;
      expect(shaped.startsWith("⚠️ SHAPED by Legion:")).toBe(true);
      expect(shaped).toContain('query_result {"result":"r1","query":');
      expect(shaped).toContain("products: 300 items{id, name, price, blurb}");
      expect(shaped.length).toBeLessThan(8_200);

      const answer = await query({ result: "r1", query: "products[?price > `397`].{name: name, price: price}" }, 2);
      expect(answer.result.isError).toBeUndefined();
      expect(JSON.parse(answer.result.content[0].text)).toEqual([{ name: "Bar 298", price: 398 }, { name: "Bar 299", price: 399 }]);
      // the upstream saw the original call and nothing else
      expect(readFileSync(join(scratch, "reply.json.calls"), "utf8")).toBe("read\n");
    });

    it("cuts a query answer to the same budget, so the whole thing never comes back", async () => {
      start({ text: full }, { OMB_GATE_BUDGET: "2000" }, SCOPED_UPSTREAM);
      await call("read");
      const answer = await query({ result: "r1", query: "@" }, 2);
      expect(answer.result.content[0].text.length).toBeLessThan(2_400);
      expect(answer.result.content[0].text).toContain("Narrow the query");
    });

    it("answers a bad handle or query as a tool error without touching upstream", async () => {
      start({ text: full }, {}, SCOPED_UPSTREAM);
      expect((await query({ result: "r9", query: "@" }, 1)).result).toMatchObject({ isError: true });
      expect((await query({ query: "@" }, 2)).result).toMatchObject({ isError: true });
      expect(existsSync(join(scratch, "reply.json.calls"))).toBe(false);
    });

    it("keeps query_result listed and callable under a tool selection that never names it", async () => {
      start({ text: full }, { OMB_GATE_TOOL_SCOPE: JSON.stringify({ allow: ["mcp:shop:read"] }) }, SCOPED_UPSTREAM);
      send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { cursor: "second" } });
      expect(JSON.parse(await nextLine()).result.tools.map((tool: { name: string }) => tool.name)).toEqual(["query_result"]);
      await call("read", 2);
      const answer = await query({ result: "r1", query: "length(products)" }, 3);
      expect(answer.result.content[0].text).toBe("300");
    });
  });

  it("strips policy from the upstream environment without losing its own configuration", async () => {
    start({}, selected, SCOPED_UPSTREAM);
    send({ jsonrpc: "2.0", id: 1, method: "peek" });
    expect(JSON.parse(await nextLine()).result).toEqual({ scope: null, upstreamOnly: "yes" });
  });
});
