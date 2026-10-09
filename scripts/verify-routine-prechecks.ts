// Real app/server, disposable data, local scripts and a local decision fixture.
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createVite } from "vite";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi, parkUntilSignal } from "./testing/preview-fixture.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const decisions: unknown[] = [];
const decision = createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    try {
      const value = JSON.parse(body);
      if (value.questions?.answer?.type === "noul") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ answers: { answer: { noul: 1 } } }));
        return;
      }
      const needed = value.state?.items?.some((item: { snippet: string }) => item.snippet.includes("urgent"));
      const choice = needed ? "needs_bot" : "noise_only";
      decisions.push({ itemCount: value.state?.items?.length, choice });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ answers: { answer: { choice,
        probabilities: needed ? { needs_bot: 0.9, noise_only: 0.1 } : { noise_only: 0.9, needs_bot: 0.1 } } } }));
    } catch { response.writeHead(400).end(); }
  });
});
await new Promise<void>(resolve => decision.listen(0, "127.0.0.1", resolve));
const decisionPort = (decision.address() as { port: number }).port;
const fixture = await launchVerificationServer();
const api = fixtureApi(fixture.info.url, { headers: { origin: fixture.info.url } });
let ui: Awaited<ReturnType<typeof createVite>> | undefined;
try {
  await runControlOmb(["new-bot", "--name", "Pre-check verification", "--url", fixture.info.url]);
  const bot = (await api("GET", "/api/bots")).bots[0];
  const sourceThread = bot.threadId;
  await api("PUT", "/api/config", { profile: { name: "Routine pre-check verification" },
    decider: { baseUrl: `http://127.0.0.1:${decisionPort}` } });
  await api("PUT", "/api/config", { decider: { enabled: true, key: "fixture-key" } });
  const checked = (value: unknown) => ({ command: process.execPath, args: ["-e", `console.log(${JSON.stringify(JSON.stringify(value))})`], timeoutMs: 1000 });
  const create = (name: string, preCheck: unknown, enabled = false) => api("POST", "/api/routines", {
    name, prompt: "Review new requests. Ignore routine advertising.", botId: bot.id,
    resultsThreadId: sourceThread, enabled,
    schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + (enabled ? 1000 : 3_600_000) }, preCheck,
  });
  const empty = (await create("Quiet empty check", checked({ items: [] }), true)).routine;
  const item = { source: "fixture", id: "message-1", from: "sender@example.com", subject: "Newsletter", snippet: "Routine newsletter" };
  const noise = (await create("Noise decision check", checked({ items: [item] }))).routine;
  const useful = (await create("Useful decision check", checked({ items: [{ ...item, snippet: "An urgent request needs review" }] }))).routine;
  const failing = (await create("Failed script wakes", { command: "/no/such/precheck" })).routine;
  // This fixture exposes only its own temporary app on a dynamically assigned
  // LAN port so the mounted Browser can reach it. API Origin is pinned to the
  // disposable server; no live app is proxied.
  ui = await createVite({ root, server: { host: "0.0.0.0", port: 0, proxy: {
    "/api": { target: fixture.info.url, changeOrigin: true, ws: true, headers: { origin: fixture.info.url } },
    "/.well-known/openmausbot/environment": { target: fixture.info.url },
  } }, logLevel: "error", plugins: [{ name: "routine-precheck-preview", configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if ((req.url ?? "").split("?")[0] !== "/__routine_prechecks.html") return next();
      void server.transformIndexHtml("/__routine_prechecks.html", '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Isolated Routine Pre-checks</title></head><body><div id="root"></div><script type="module" src="/scripts/testing/threads-preview.tsx"></script></body></html>')
        .then(value => { res.setHeader("content-type", "text/html"); res.end(value); }).catch(next);
    });
  } }] });
  await ui.listen();
  const previewPort = (ui.httpServer!.address() as { port: number }).port;
  const info = { ...fixture.info, previewPort, botId: bot.id, sourceThread,
    routines: { empty: empty.id, noise: noise.id, useful: useful.id, failing: failing.id } };
  writeFileSync(`${fixture.info.logPath}.setup.json`, JSON.stringify(info, null, 2));
  console.log(JSON.stringify(info));
  await parkUntilSignal();
} finally {
  const snapshot = await api("GET", "/api/routines").catch(() => null);
  const persisted = snapshot ? undefined : JSON.parse(readFileSync(join(fixture.info.dataDir, "routines.json"), "utf8"));
  writeFileSync(`${fixture.info.logPath}.evidence.json`, JSON.stringify({ snapshot, persisted, decisions }, null, 2));
  await ui?.close();
  await fixture.close();
  await new Promise<void>(resolve => decision.close(() => resolve()));
}
