# Self-update fixture

Follow [README.md](README.md). Never configure the real installation, restart a
real service, or send mutating requests to a discovered app URL.

Use Node 24+ and the repository dependencies:

```sh
pnpm exec vitest run server/updater.test.ts --cache=false
node --experimental-strip-types scripts/verify-self-update.ts
node --experimental-strip-types scripts/verify-self-update.ts --ui
pnpm typecheck
```

`verify-self-update.ts` builds three minimal synthetic `openmausbot` packages
(1.0.0, 2.0.0, broken 3.0.0) with real tgz files, serves a JSON registry on an
owned ephemeral loopback port and installs v1 using real npm. The fixture owns
an isolated `app/vendor/` layout, data/home/cache/bin directories and package
health server under a unique tmp directory. It bundles the production update
worker and mounts the production updater route module on a second loopback
HTTP server. Fake `systemctl` and `systemd-run` executables implement only the
fixture unit: restart stops the exact owned package process and launches the
installed package again. No real service manager mutation occurs.

The script also launches the repository's isolated fake-engine server through
`launchVerificationServer`, proving default-off responses, real config
persistence and rejection of a paired member. Fixture proxy headers are refused
on all three updater routes.

The JSON result contains acceptance evidence:

| Case | Assertions / evidence |
| --- | --- |
| (a) plan | `current:1.0.0`, `target:2.0.0`, CHANGELOG delta, exact computed SHA-256, positive tgz size |
| (b) apply | Real manifest swap and npm install; restarted package health reports 2.0.0; persisted state `applied`; v2 artifact downloaded exactly once across plan/apply |
| (c) rollback | Broken v3 returns 503 on health; state `rolled-back`, current 2.0.0; previous manifest/lockfile restored; restarted v2 healthy; `rolling-back` and `rolled-back` decision-log rows |
| (d) off | The real isolated server returns exactly `{enabled:false}` from state, plan and apply with no updater config |
| (e) checksum | Registry mismatch refused with 422; tampered verified cache also refused at apply; manifest unchanged, no extra service restart |

Additional Vitest cases cover SemVer numeric/prerelease/build precedence,
local directory indexes, channel selection, and checkout/Docker manual no-ops.
The HTTP fixture also proves a second apply returns 409 and reports active turns
without blocking the first update. The systemd cgroup boundary is represented
by fake executables; actual user-manager/cgroup operation is not exercised.

`--ui` mounts the actual Settings modal, Store provider and Software Update
component in Vite, using the real isolated server for ordinary APIs and the
synthetic npm fixture for updater APIs. Chromium checks verified plan/delta,
confirmation, Cancel leaving v1 installed, v2 application and the v3 rollback
notice. Snapshots and screenshots (`confirm.png`, `applied.png`, `rollback.png`)
are written under `.omb-scratch/self-update-evidence/`. Browser tools/cache are
kept inside the worktree. To reuse an existing Chromium, set
`AGENT_BROWSER_EXECUTABLE_PATH` to its absolute executable path.

Every fixture, child health server, update worker and browser session is stopped
and its unique temporary directories removed. The UI browser is closed because
this ticket requires killing everything. Only worktree-local evidence remains.

Targeted related checks (skip the full suite):

```sh
pnpm exec vitest run server/updater.test.ts server/config.test.ts \
  server/decision-log.test.ts server/decision-log-wiring.test.ts \
  server/activity.test.ts server/environment.test.ts \
  src/components/SettingsModal.*test.ts --cache=false
```
