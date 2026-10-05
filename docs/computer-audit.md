# Computer audit log and instant revocation

Every computer a bot drives keeps an append-only audit trail, and the owner can
cut a bot's access mid-action.

## What is recorded

One row per computer action, written at the single point where computer tool
calls pass (`POST /api/internal/computer/mcp`, wrapped once by
`auditedComputerCall` in `server/computer-audit.ts`):

```json
{ "ts": 1791179928342, "computerId": "bot-<botId>", "botId": "…", "actor": "bot",
  "action": "exec", "outcome": "ok", "durationMs": 16 }
```

- `actor`: `bot` for tool calls and help requests, `owner` for takeover, release and revoke.
- `action`: the tool name (`click`, `exec`, `screenshot`, …), `takeover.take`,
  `takeover.release`, `takeover.help`, `revoke`, or `shared.<operation>` for a
  lent computer (`shared.computer_call`).
- `outcome`: `ok`, `denied` (a person had control, the owner or a space
  boundary revoked access, or the call was cancelled mid-run) or `error`.
- `error`: a short, redacted reason on non-ok rows (at most 200 characters).
  Cancelled calls read `cancelled: <reason>`.

**Privacy.** Arguments are never stored: not the typed text, shell command,
URL or coordinates. The log says that `type_text` ran and how long it took, not
what was typed. Do not add arguments to a row; if a failure needs detail, put
it in the bot's transcript, which the owner already controls.

## Storage and retention

`<data>/computer-audit/<computerId>.ndjson`, mode 0600, one file per computer.
A computer is keyed `computer_<id>` for a shared team computer and
`bot-<botId>` otherwise. Each file keeps the newest 5000 rows; it is trimmed
once it grows 10% (at most 250 rows) past the cap, and reads never return more
than the cap. Writes never throw: an audit failure does not block the action.

## Coverage

Fully audited with duration and outcome: the cloud computer tools served by the
harness. Shared (lent) computer requests are audited with their operation name.
Takeover, release and help requests are audited from the control record. Local
VM, VPS and host-control computers run through a stdio bridge that forwards
calls without the harness seeing the result, so they are not yet audited per
tool call.

## Instant revocation

`server/computer-epoch.ts` keeps an epoch per bot-computer binding and a lease
per in-flight call. A lease carries an `AbortController` and a `check` that
re-derives permission. The dispatcher checks the epoch before dispatch and
after each await; revocation bumps the epoch and aborts the lease's signal,
which the Boat request listens to, so the call stops in milliseconds instead
of running to completion. The bot gets a "revoked, do not retry" tool result.

Triggers (all synchronous on the event):

- The owner disables the bot's computer (`computer: off`): any bot change
  re-runs `revalidate` for that bot.
- Space isolation: the bot or a shared computer is reassigned to another space
  (`PUT /api/spaces/assign` re-runs `revalidate` for everyone).
- Approval mode downgraded to Ask while a call that started under a higher
  mode is running.
- The owner presses **Revoke access** in the panel's Audit tab
  (`POST /api/computer-audit/revoke`); the response carries `cancelled`, and
  the panel shows "N action cancelled".

## API

Both routes need admin scope and respect `x-omb-space` scoping.

- `GET /api/computer-audit?botId=…&filterBot=…&action=…&outcome=ok|denied|error&limit=200`
  returns `{ computerId, rows }`, newest first.
- `POST /api/computer-audit/revoke` with `{ botId, reason? }` returns `{ cancelled }`.
