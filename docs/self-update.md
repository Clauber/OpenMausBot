# Software Update

The server updater is off unless `config.json` explicitly enables a private
artifact registry. It has no default registry and never asks the public npm
registry for a release. The desktop application's existing updater is separate.

```json
{
  "updater": {
    "enabled": true,
    "channel": "stable",
    "registryUrl": "https://updates.example.com/legion/index.json",
    "unit": "openmausbot.service"
  }
}
```

`channel` defaults to `stable`. `registryUrl` accepts an HTTP(S) index, a
directory URL ending in `/` (reads `index.json`), an absolute local directory,
or an absolute local index path / `file:` URL. URL credentials and redirects
are refused. Host the index on infrastructure you trust: hashes verify the
artifact against the index; they do not authenticate the registry publisher.
The optional `unit` is a **systemd user** unit, not a system-wide unit.

The index is an array, or an object containing `releases`:

```json
{
  "releases": [{
    "version": "0.2.0",
    "channel": "stable",
    "url": "openmausbot-0.2.0.tgz",
    "sha256": "<64 hexadecimal characters>",
    "changelog": "CHANGELOG excerpt: fixes and changes in this release"
  }]
}
```

URLs resolve relative to the index. Publish `changelog` as plain text copied
from the release's CHANGELOG. Versions use SemVer precedence, including numeric
prerelease ordering; stable excludes prereleases. Each artifact must be a tgz
with the `openmausbot` package version matching the index. Build and pack the
repository's bundled npm package so installing it needs no dependency downloads
or lifecycle scripts. Limits: index 1 MiB, artifact 200 MiB, displayed CHANGELOG
64 KiB, fetch timeout 120 seconds.

Open **Settings → General → Software Update** on the local server. Check for
updates displays the version delta, size, SHA-256 and CHANGELOG. Apply opens a
confirmation card explaining the restart and rollback. Progress and results
persist across server restarts. Running turns are reported and do not block an
update; the service restart can interrupt them. Paired remote clients cannot
use the updater, including admin sessions. Proxied requests, reduced loopback
service trust and space-scoped requests are refused.

## API

All routes sit behind the usual authentication/origin gate and additionally
require the local loopback owner. Responses are never cached.

| Route | Result |
| --- | --- |
| `GET /api/updater/state` | Current installed package version, `npm-package` / `checkout` / `docker` layout, channel, busy flag, running turns, last check and apply |
| `GET /api/updater/plan` | Newest newer version in the selected channel; verified hash, downloaded size and optional CHANGELOG; `target:null` when current |
| `POST /api/updater/apply` | `{ "target": "0.2.0", "sha256": "…" }` confirms the reviewed plan; `{}` uses the last plan; 202 starts work, 409 refuses concurrent/stale work |

Without enabled configuration **and** a registry URL, each route returns only
`{"enabled":false}` and performs no work. Checking downloads and caches a
verified artifact under `<data>/updater/cache/<sha256>.tgz`. Apply reuses it,
copies it into a private temporary job, and verifies the digest again before
any installation change. A mismatched digest returns 422 before swapping.

## Apply and rollback

Automatic apply supports Linux npm-package installations shaped as:

```text
<root>/app/package.json          dependencies.openmausbot = file:vendor/previous.tgz
<root>/app/vendor/previous.tgz   retained for rollback
<root>/app/node_modules/openmausbot/
```

The updater discovers this app ancestor from its server bundle location. Docker
is detected through the container marker/environment; other installations are
reported as checkouts. Checkout, Docker, non-Linux, or missing-unit apply returns
`lastApply.status:"manual"` with instructions, leaving the installation untouched.
An unloaded configured user unit is refused before swapping.

Apply acquires an atomic filesystem lock in `app/.apply-lock`. It copies the
old release's bundled worker outside `node_modules`, then launches it using
`systemd-run --user --collect` in an independent transient unit. A merely
detached child could still be killed with the server's cgroup. This worker stages
the verified tgz in `vendor/`, saves recovery copies of the manifest and lockfile,
updates the file dependency, and runs `npm install --offline --ignore-scripts
--no-audit --no-fund` with a private cache and empty user/global npm configs.
The application must therefore have an installable offline dependency set.

After installation it runs `systemctl --user restart <unit>` and polls
`http://127.0.0.1:<server-port>/api/health` for at most 15 seconds (one-second
request timeout). A 200 response must identify `openmausbot` **and the target
version**. A stale or unrelated server cannot satisfy the check. The new release
must ship this version-bearing health endpoint. Installation, restart, version
or health failure restores the exact previous manifest and lockfile, reinstalls,
restarts, and verifies the previous version. Successful rollback is reported as
`rolled-back`; the installed version remains the previous version.

Results live in `<data>/updater/state.json`. Plan/hash/size, acceptance with active
turn count, installation, restart, health and rollback transitions are written as
`source:"updater"`, `decision:"update"` rows in the existing monthly decision log.
Completed jobs remove their temporary worker/cache and lock. Previous vendor
artifacts and verified download cache remain available for later checks/recovery.

If rollback itself fails, the status is `rollback-failed` and the lock/recovery
copies are retained; automatic updates remain blocked. If the worker crashes or
the machine loses power, a remaining lock also blocks retries. Inspect
`app/.apply-lock/job.json`, the saved `package.json.before` and (if present)
`package-lock.json.before`, the persisted result and the transient unit's journal.
Recover and verify the old version manually before removing that specific lock.
Do not remove an active job's lock. This updater does not roll back user data or
database migrations; publish releases compatible with the previous data format.

Fixture acceptance and browser checks: [verification/self-update.md](verification/self-update.md).
