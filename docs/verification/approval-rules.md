# Approval rules verification

Run from the Legion checkout with dependencies installed. All mutations go
to disposable fixtures; never point this recipe at a running personal app.

```sh
node --experimental-strip-types scripts/verify-approval-rules.ts
```

The script owns a `control-omb` fake-engine server, a temporary data directory
and loopback fake Jev/connector HTTP server. It uses the existing Jev client
protocol (`/v1/systemone`), with synthetic credentials confined to loopback.
The injected MCP capability is read from the fixture's engine dump and never
printed. No production model or connector executes.

Assertions cover:

1. An Auto bot with a daily allowance and `require_approval` gets a connector
   card carrying an effect key. Allow executes once. A native Write permission
   and preallowed internal deletion are also forced to cards and denied.
   An exact advertised routine-action rule is checked separately. A native
   consequential card's first bot-level Allow succeeds and its replay is 409.
2. `always_allow` executes a send and records both its rule and allowance
   receipt (2/20 after the first two approved sends).
3. Fake Jev confidently denies a fabricated send, asks explicitly, and converts
   a 0.55-confidence allow into a card. Denied actions never reach upstream.
4. Simultaneous normalized requests execute once (200/409). Sequential replay,
   approved-card replay, and duplicate children in a batch return
   `409 {"code":"effect_replayed"}`.

The script also checks workspace defaults, invalid rules (400), member edits
(403), and unavailable-judge fallback. It captures `control-omb send`, bounded
`wait` and `messages`, card/log/allowance state and execution counts in the
printed `SERVER_LOG.approval-rules.json` (0600). It interrupts the fixture turn
and closes its owned server/upstream/sockets in `finally`; logs survive cleanup.

For renderer verification, launch a separate owned UI fixture in one terminal:

```sh
node --experimental-strip-types scripts/control-omb.ts ui launch
```

In another terminal, copy that launcher's explicit handle:

```sh
node --experimental-strip-types scripts/verify-approval-rules.ts \
  --ui /tmp/openmausbot-verify-data-XXXXXX/ui.json
```

This checks real Permissions controls, saves exact tool and category rules,
confirms the server's persisted values, closes/reopens settings, and rejects
overlapping tool lists without changing persisted settings. Evidence and a
screenshot are written to `.omb-scratch/verify-evidence/approval-rules/`.
Inspect `settings.png` and `ui.json`. Stop the foreground UI launcher with
Ctrl-C to terminate its exact browser, preview and server.

Focused automated checks:

```sh
pnpm typecheck
pnpm exec vitest run server/approval-rules.test.ts server/auto-review.test.ts \
  server/effect-ledger.test.ts server/auto-approve.test.ts \
  server/approval-rules.e2e.test.ts
```

These fixtures prove harness-visible execution gates. They do not prove that
a real CLI in a permissive mode emits permission requests for internally
approved native tools; see [the provider boundary](../approval-rules.md).
