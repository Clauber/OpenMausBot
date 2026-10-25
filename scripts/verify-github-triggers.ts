// Real HTTP ingress and routine execution, confined to the shared disposable fixture.
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi } from "./testing/preview-fixture.ts";

export async function verifyGithubTriggers() {
  const fixture = await launchVerificationServer();
  const evidencePath = `${fixture.info.logPath}.github.json`;
  const evidence: Record<string, any> = { fixture: fixture.info, cases: {}, cleanup: false };
  const api = fixtureApi(fixture.info.url, { headers: { origin: fixture.info.url } });
  const secret = randomBytes(32).toString("hex");
  const push = { repository: { full_name: "owner/name" }, sender: { login: "alice" }, ref: "refs/heads/main", commits: [{ message: "one" }, { message: "two" }, { message: "three" }], head_commit: { message: "Ship fixture café\nDetails omitted" } };
  try {
    const { bot } = await runControlOmb(["new-bot", "--name", "GitHub fixture", "--url", fixture.info.url]) as any;
    const created = await api("POST", "/api/routines", { name: "GitHub event review", prompt: "Summarize this fixture event.", botId: bot.id, enabled: true, schedule: { type: "interval", everyMinutes: 5, anchorAt: Date.now() }, github: { secret, repo: "owner/name", events: ["push", "pull_request"] } });
    const id = created.routine.id;
    assert.equal(created.routine.nextRunAt, null);
    assert.equal(created.routine.github.secret, undefined);
    const configPath = join(fixture.info.dataDir, "routines.json");
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).routines.find((r: any) => r.id === id).github.secret, secret);
    const { ingress } = await api("GET", "/api/webhooks");
    assert.equal(ingress.available, true);
    const endpoint = `${ingress.baseUrl}/hooks/github/${id}`;
    evidence.routineId = id; evidence.endpoint = endpoint; evidence.privateConfigMode = "0600";
    const send = async (payload: unknown, event: string, delivery: string, signature: "valid" | "bad" | "missing" = "valid") => {
      const raw = JSON.stringify(payload);
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", "x-github-event": event, "x-github-delivery": delivery, ...(signature === "missing" ? {} : { "x-hub-signature-256": signature === "bad" ? `sha256=${"0".repeat(64)}` : `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}` }) }, body: raw });
      return { status: response.status, body: await response.json() as any };
    };
    const state = () => api("GET", "/api/routines");
    const runs = async () => (await state()).runs.filter((r: any) => r.routineId === id);
    const waitRun = async (runId: string) => {
      const deadline = Date.now() + 30_000;
      while (true) {
        const run = (await runs()).find((r: any) => r.id === runId);
        if (run?.status === "completed") return run;
        assert.notEqual(run?.status, "failed", run?.error);
        if (Date.now() > deadline) throw new Error(`Run ${runId} timed out; see ${fixture.info.logPath}`);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    };
    const valid = await send(push, "push", "fixture-push");
    assert.equal(valid.status, 200); assert.ok(valid.body.runId);
    const pushRun = await waitRun(valid.body.runId);
    assert.match(pushRun.prompt, /GitHub push to owner\/name by alice: 3 commits, main — Ship fixture café/);
    assert.equal(pushRun.triggerSource, "webhook");
    assert.ok(pushRun.resultsThreadId);
    const transcript = await runControlOmb(["messages", "--bot", bot.id, "--task", pushRun.threadId, "--limit", "20", "--url", fixture.info.url]);
    evidence.cases.a = { response: valid, run: pushRun, transcript };
    const bad = await send(push, "push", "fixture-bad", "bad");
    const missing = await send(push, "push", "fixture-missing", "missing");
    assert.equal(bad.status, 401); assert.equal(missing.status, 401);
    const rejected = (await api("GET", "/api/webhooks")).attempts.filter((a: any) => a.webhookId === id && ["fixture-bad", "fixture-missing"].includes(a.deliveryId));
    assert.equal(rejected.length, 2); assert.ok(rejected.every((a: any) => a.statusCode === 401 && a.outcome === "rejected"));
    assert.equal((await runs()).length, 1);
    evidence.cases.b = { bad, missing, attempts: rejected, runCount: 1 };
    const repo = await send({ ...push, repository: { full_name: "other/repo" } }, "push", "fixture-repo");
    const event = await send(push, "issues", "fixture-event");
    assert.equal(repo.status, 200); assert.equal(event.status, 200); assert.ok(repo.body.ignored && event.body.ignored);
    assert.equal((await runs()).length, 1);
    evidence.cases.c = { repo, event, runCount: 1 };
    const replay = await send(push, "push", "fixture-push");
    assert.equal(replay.status, 200); assert.equal(replay.body.duplicate, true); assert.equal(replay.body.runId, pushRun.id);
    assert.equal((await runs()).length, 1);
    evidence.cases.d = { replay, runCount: 1 };
    await api("PATCH", `/api/routines/${id}`, { github: { repo: "owner/name", events: ["pull_request"], actions: ["merged"] } });
    const pr = { repository: push.repository, sender: push.sender, action: "opened", number: 17, pull_request: { title: "Fixture pull request", merged: false } };
    const filtered = await send(pr, "pull_request", "fixture-pr-filtered");
    assert.equal(filtered.status, 200); assert.equal(filtered.body.ignored, true); assert.equal((await runs()).length, 1);
    await api("PATCH", `/api/routines/${id}`, { github: { repo: "owner/name", events: ["pull_request"], actions: ["opened"] } });
    const opened = await send(pr, "pull_request", "fixture-pr-opened");
    assert.equal(opened.status, 200); assert.ok(opened.body.runId);
    const prRun = await waitRun(opened.body.runId);
    assert.match(prRun.prompt, /GitHub pull_request opened in owner\/name by alice: #17 — Fixture pull request/);
    assert.equal(prRun.resultsThreadId, pushRun.resultsThreadId);
    assert.equal((await runs()).length, 2);
    evidence.cases.e = { filtered, opened, run: prRun, runCount: 2 };
    evidence.final = await state();
    evidence.attempts = (await api("GET", "/api/webhooks")).attempts;
    assert.ok(!JSON.stringify(evidence).includes(secret));
    evidence.ok = true;
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await fixture.close();
    evidence.cleanup = true;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ ok: evidence.ok ?? false, evidencePath, logPath: fixture.info.logPath, cases: Object.keys(evidence.cases), cleanup: true }));
  }
  return { evidencePath, evidence };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await verifyGithubTriggers();
