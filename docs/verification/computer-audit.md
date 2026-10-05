# Computer audit verification

Use Node 24 or later and isolated fixtures only. Never target live workspace data.

```sh
pnpm exec tsc -p tsconfig.server.json
pnpm exec vitest run server/computer-audit.test.ts server/cloud-computer-tools.test.ts
node --experimental-strip-types scripts/verify-computer-audit.ts
```

The unit test and the driver use a loopback fake Boat and the real audit log,
epoch watcher and `cloudComputerRpc`:

- (a) Three actions (`type_text`, `exec`, `click`) → three `ok` rows, actor
  `bot`; the audit file contains none of the typed text, command or coordinates.
- (b) A held `exec` is revoked mid-run → `revoke` reports 1 cancelled, the call
  settles in about 10ms (asserted under 250ms), and the row is
  `denied` / `cancelled: the owner revoked access`.
- (c) A call refused by the access check (space isolation) → `denied` row.
- (d) 1000 appends with a cap of 100 → 100 retained.

Part 2 launches the real server fixture and drives HTTP: takeover and release
write `owner` rows, `GET /api/computer-audit` filters by action and outcome,
a bad outcome is `400`, an unknown bot is `404`, `POST /api/computer-audit/revoke`
returns `cancelled: 0` and writes a `revoke` row, and a request scoped to
another space is `403 space_isolation`. Evidence is written next to the fixture
log as `*.computer-audit.json`. The driver kills its fixture on exit.
