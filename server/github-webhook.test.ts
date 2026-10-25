import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { RoutineManager } from "./routines.ts";
import { WebhookManager } from "./webhooks.ts";
import { createGithubIngress, validGithubSignature } from "./github-webhook.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const secret = "fixture-github-secret";
const payload = { repository: { full_name: "owner/name" }, sender: { login: "alice" }, ref: "refs/heads/main", commits: [{ message: "Ship café" }], head_commit: { message: "Ship café\nMore details" } };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "legion-github-test-")); dirs.push(dir);
  const emitted: unknown[] = [];
  const options = { file: join(dir, "routines.json"), botState: () => "busy" as const, createTask: () => ({ threadId: "execution" }), startTurn: async () => {}, emit: (event: unknown) => { emitted.push(event); } };
  const routines = new RoutineManager(options);
  const hooks = new WebhookManager({ file: join(dir, "webhooks.json"), botState: options.botState, enqueue: input => routines.enqueueWebhook(input) });
  const routine = routines.create({ name: "GitHub fixture", botId: "fixture-bot", prompt: "Review this change.", schedule: { type: "interval", everyMinutes: 5, anchorAt: Date.now() }, github: { secret, repo: "owner/name", events: ["push", "pull_request"] } });
  const ingress = createGithubIngress(routines, hooks);
  const send = (body: unknown = payload, event = "push", deliveryId = "delivery-1", signature?: string) => {
    const raw = Buffer.from(JSON.stringify(body));
    return ingress.receive(routine.id, raw, { event, deliveryId, signature: signature ?? `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}` });
  };
  return { dir, routines, hooks, routine, ingress, send, emitted, options };
}

it("uses GitHub's documented signature vector and authenticates exact bytes", () => {
  expect(validGithubSignature(Buffer.from("Hello, World!"), "It's a Secret to Everybody", "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17")).toBe(true);
  expect(validGithubSignature(Buffer.from("Hello, World?"), "It's a Secret to Everybody", "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17")).toBe(false);
  for (const signature of [undefined, "sha256=0", `sha1=${"a".repeat(64)}`, `sha256=${"z".repeat(64)}`]) expect(validGithubSignature(Buffer.from("{}"), secret, signature)).toBe(false);
});

it("persists a private secret, suspends timer dispatch and preserves configuration on edits", async () => {
  const f = fixture();
  expect(JSON.stringify([f.routine, f.emitted, f.routines.listRoutines()])).not.toContain(secret);
  expect(statSync(join(f.dir, "routines.json")).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(join(f.dir, "routines.json"), "utf8")).routines[0].github.secret).toBe(secret);
  expect(f.routine.nextRunAt).toBeNull();
  await f.routines.tick(); expect(f.routines.listRuns()).toHaveLength(0);
  f.routines.update(f.routine.id, { name: "Renamed", github: { repo: "owner/name", events: ["push"] } });
  expect(f.send().status).toBe(200);
  expect(f.routines.listRuns()[0]).toMatchObject({ routineId: f.routine.id, triggerSource: "webhook", prompt: expect.stringContaining("owner/name by alice: 1 commit, main — Ship café") });
  f.routines.update(f.routine.id, { github: null });
  expect(f.routines.listRoutines()[0].nextRunAt).not.toBeNull();
});

it("logs rejection before parsing, filters events and repositories, and deduplicates after restart", () => {
  const f = fixture();
  expect(f.ingress.receive(f.routine.id, Buffer.from("invalid JSON"), { event: "push", deliveryId: "missing" }).status).toBe(401);
  expect(f.send(payload, "push", "bad", "sha256=bad").status).toBe(401);
  expect(f.hooks.listAttempts().map(a => a.statusCode)).toEqual([401, 401]);
  expect(f.send({ ...payload, repository: { full_name: "other/repo" } }, "push", "repo").body).toMatchObject({ ignored: true });
  expect(f.send(payload, "issues", "event").body).toMatchObject({ ignored: true });
  expect(f.routines.listRuns()).toHaveLength(0);
  const first = f.send(); expect(first.status).toBe(200);
  expect(f.send().body).toMatchObject({ duplicate: true, runId: first.body.runId });
  const restarted = new RoutineManager(f.options);
  const replay = createGithubIngress(restarted, f.hooks).receive(f.routine.id, Buffer.from(JSON.stringify(payload)), { event: "push", deliveryId: "delivery-1", signature: `sha256=${createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex")}` });
  expect(replay.body).toMatchObject({ duplicate: true, runId: first.body.runId });
  expect(restarted.listRuns()).toHaveLength(1);
});

it("matches PR actions including GitHub's closed+merged payload, and honors pause", () => {
  const f = fixture();
  f.routines.update(f.routine.id, { github: { repo: "owner/name", events: ["pull_request"], actions: ["merged"] } });
  const pr = { ...payload, action: "opened", number: 7, pull_request: { title: "Ship café", merged: false } };
  expect(f.send(pr, "pull_request", "opened").body).toMatchObject({ ignored: true });
  expect(f.send({ ...pr, action: "closed" }, "pull_request", "unmerged").body).toMatchObject({ ignored: true });
  expect(f.send({ ...pr, action: "closed", pull_request: { ...pr.pull_request, merged: true } }, "pull_request", "merged").body.runId).toBeTruthy();
  f.routines.update(f.routine.id, { github: { repo: "owner/name", events: ["pull_request"], actions: ["opened"] } });
  expect(f.send(pr, "pull_request", "opened").body.runId).toBeTruthy();
  f.routines.update(f.routine.id, { enabled: false });
  expect(f.send(pr, "pull_request", "paused").body).toMatchObject({ ignored: true });
  expect(f.routines.listRuns()).toHaveLength(2);
});

it("rolls back a failed receipt commit so retry can still create exactly one run", () => {
  const f = fixture();
  const internals = f.routines as unknown as { save(): void };
  vi.spyOn(internals, "save").mockImplementationOnce(() => { throw new Error("fixture disk full"); });
  expect(f.send().status).toBe(500);
  expect(f.routines.listRuns()).toHaveLength(0);
  expect(f.routines.webhookRunReceipt(f.routine.id, "delivery-1")).toBeNull();
  expect(f.send().body).toMatchObject({ duplicate: false });
  expect(f.send().body).toMatchObject({ duplicate: true });
  expect(f.routines.listRuns()).toHaveLength(1);
});

it("rejects invalid signed payloads and headers, and supports secret rotation", () => {
  const f = fixture();
  expect(f.send({}).status).toBe(400);
  expect(f.send(payload, "push", "").status).toBe(400);
  const raw = Buffer.from("invalid JSON");
  const signature = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  expect(f.ingress.receive(f.routine.id, raw, { signature, event: "push", deliveryId: "json" }).status).toBe(400);
  expect(f.send({}, "ping", "ping").body).toMatchObject({ ignored: true });
  expect(() => f.routines.update(f.routine.id, { github: { repo: "bad", events: [] } })).toThrow("Invalid GitHub trigger");
  f.routines.update(f.routine.id, { github: { repo: "owner/name", events: ["push"], secret: "rotated-fixture-secret" } });
  expect(f.send().status).toBe(401);
  expect(f.routines.listRuns()).toHaveLength(0);
});
