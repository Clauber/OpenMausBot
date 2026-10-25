import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createSelfUpdateFixture, verifyFixtureHealth } from "../server/testing/self-update-fixture.ts";
import { readDecisions } from "../server/decision-log.ts";
import { launchVerificationServer } from "./control-omb.ts";

export async function verifySelfUpdate() {
  const fixture = await createSelfUpdateFixture();
  let production: Awaited<ReturnType<typeof launchVerificationServer>> | undefined;
  try {
    production = await launchVerificationServer({});
    const disabled = [];
    for (const [method, path] of [["GET", "state"], ["GET", "plan"], ["POST", "apply"]]) {
      const response = await fetch(`${production.info.url}/api/updater/${path}`, { method, headers: { origin: production.info.url }, signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      const body = await response.json(); assert.deepEqual(body, { enabled: false }); disabled.push(body);
    }
    // The production config parser retains updater configuration; remote sessions
    // and proxy headers still cannot grant local owner update authority.
    const patch = await fetch(production.info.url + "/api/config", { method: "PATCH", headers: { origin: production.info.url, "content-type": "application/json" }, body: JSON.stringify({ updater: { enabled: true, registryUrl: fixture.config()!.registryUrl } }) });
    assert.equal(patch.status, 200);
    const liveState = await fetch(production.info.url + "/api/updater/state", { headers: { origin: production.info.url } }).then(r => r.json()) as { enabled: boolean };
    assert.equal(liveState.enabled, true, await readFile(join(production.info.dataDir, "config.json"), "utf8"));
    const pair = await fetch(production.info.url + "/api/auth/pairing", { method: "POST", headers: { origin: production.info.url, "content-type": "application/json" }, body: JSON.stringify({ label: "Updater member fixture", scopes: ["client"] }) }).then(r => r.json()) as { code: string };
    const paired = await fetch(production.info.url + "/api/auth/pair", { method: "POST", headers: { origin: production.info.url, "content-type": "application/json" }, body: JSON.stringify({ code: pair.code }) }).then(r => r.json()) as { token: string };
    const member = await fetch(production.info.url + "/api/updater/state", { headers: { origin: production.info.url, authorization: `Bearer ${paired.token}` } });
    assert.equal(member.status, 403);
    const adminPair = await fetch(production.info.url + "/api/auth/pairing", { method: "POST", headers: { origin: production.info.url, "content-type": "application/json" }, body: JSON.stringify({ label: "Updater admin fixture", scopes: ["admin", "client"] }) }).then(r => r.json()) as { code: string };
    const admin = await fetch(production.info.url + "/api/auth/pair", { method: "POST", headers: { origin: production.info.url, "content-type": "application/json" }, body: JSON.stringify({ code: adminPair.code }) }).then(r => r.json()) as { token: string };
    for (const [method, path] of [["GET", "state"], ["GET", "plan"], ["POST", "apply"]]) {
      const response = await fetch(`${production.info.url}/api/updater/${path}`, { method, headers: { origin: production.info.url, authorization: `Bearer ${admin.token}`, "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
      assert.equal(response.status, 403, "paired admins cannot update the server");
    }
    for (const [method, path] of [["GET", "state"], ["GET", "plan"], ["POST", "apply"]]) {
      assert.equal((await fixture.request(method!, `/api/updater/${path}`, method === "POST" ? {} : undefined, { "x-forwarded-for": "127.0.0.1" })).status, 403);
    }
    const healthV1 = await verifyFixtureHealth(fixture.healthUrl, "1.0.0");
    const planReply = await fixture.request("GET", "/api/updater/plan");
    assert.equal(planReply.status, 200);
    const plan = planReply.body;
    assert.equal(plan.current, "1.0.0"); assert.equal(plan.target, "2.0.0");
    assert.equal(plan.sha256, fixture.hashes["2.0.0"]);
    assert.ok(plan.size > 0); assert.match(plan.changes, /CHANGELOG 2.0.0/);
    const apply = await fixture.request("POST", "/api/updater/apply", { target: plan.target, sha256: plan.sha256 });
    assert.equal(apply.status, 202);
    assert.equal(apply.body.runningTurns, 2);
    assert.equal((await fixture.request("POST", "/api/updater/apply", {})).status, 409);
    const applied = await fixture.waitForResult();
    assert.equal(applied.current, "2.0.0"); assert.equal(applied.lastApply?.status, "applied");
    assert.equal(fixture.downloads["2.0.0"], 1, "plan/apply must share the verified artifact");
    const healthV2 = await verifyFixtureHealth(fixture.healthUrl, "2.0.0");
    const v2Manifest = await readFile(join(fixture.appDir, "package.json"), "utf8");
    const v2Lock = await readFile(join(fixture.appDir, "package-lock.json"), "utf8");
    fixture.setReleases(["1.0.0", "2.0.0", "3.0.0"]);
    const brokenPlan = (await fixture.request("GET", "/api/updater/plan")).body;
    assert.equal(brokenPlan.target, "3.0.0");
    assert.equal((await fixture.request("POST", "/api/updater/apply", { target: brokenPlan.target, sha256: brokenPlan.sha256 })).status, 202);
    const rollback = await fixture.waitForResult();
    assert.equal(rollback.current, "2.0.0"); assert.equal(rollback.lastApply?.status, "rolled-back");
    assert.match(rollback.lastApply!.message!, /Health check failed/);
    assert.equal(await readFile(join(fixture.appDir, "package.json"), "utf8"), v2Manifest);
    assert.equal(await readFile(join(fixture.appDir, "package-lock.json"), "utf8"), v2Lock);
    await verifyFixtureHealth(fixture.healthUrl, "2.0.0");
    const audit = readDecisions(fixture.dataDir, 100);
    assert.ok(audit.some(row => row.source === "updater" && row.summary?.includes("rolling-back")));
    assert.ok(audit.some(row => row.summary?.includes("rolled-back")));
    assert.ok(audit.some(row => row.summary?.includes("runningTurns=2")));
    // Registry mismatch is rejected in plan, and tampering with a previously
    // verified cache is rejected again at apply before the manifest is changed.
    fixture.setReleases(["3.0.0"], true);
    const mismatch = await fixture.request("GET", "/api/updater/plan");
    assert.equal(mismatch.status, 422); assert.match(mismatch.body.error, /SHA-256 mismatch/);
    assert.equal(await readFile(join(fixture.appDir, "package.json"), "utf8"), v2Manifest);
    fixture.setReleases(["3.0.0"]);
    await fixture.request("GET", "/api/updater/plan");
    await writeFile(join(fixture.dataDir, "updater/cache", `${fixture.hashes["3.0.0"]}.tgz`), "tampered");
    const tampered = await fixture.request("POST", "/api/updater/apply", {});
    assert.equal(tampered.status, 422); assert.match(tampered.body.error, /SHA-256 mismatch/);
    assert.equal(await readFile(join(fixture.appDir, "package.json"), "utf8"), v2Manifest);
    assert.equal(fixture.restarts.length, 3, "success + broken target + rollback only");
    fixture.setConfig({ enabled: true, registryUrl: fixture.config()!.registryUrl });
    const noUnit = await fixture.request("POST", "/api/updater/apply", {});
    assert.equal(noUnit.status, 200); assert.equal(noUnit.body.lastApply.status, "manual");
    assert.equal(await readFile(join(fixture.appDir, "package.json"), "utf8"), v2Manifest);
    assert.equal(fixture.restarts.length, 3);
    return { plan, applied, rollback, disabled, badHash: mismatch.body.error as string, tampered: tampered.body.error, downloads: fixture.downloads, audit: audit.map(row => row.summary), healthV1, healthV2, restarts: fixture.restarts, noUnit: noUnit.body.lastApply, security: { member: member.status, pairedAdmin: 403, proxied: 403 } };
  } finally {
    await production?.close();
    if (production) await rm(production.info.logPath, { force: true });
    await fixture.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = process.argv.includes("--ui") ? await (await import("./testing/self-update-ui.ts")).verifySelfUpdateUi() : await verifySelfUpdate();
  console.log(JSON.stringify(result, null, 2));
}
