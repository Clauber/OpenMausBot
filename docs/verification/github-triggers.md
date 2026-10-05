# Signed GitHub routine triggers

GitHub deliveries enter the separate webhook listener at
`POST /hooks/github/<routineId>` (normally port 8800). A routine's optional
`github` configuration replaces timer dispatch while retaining its saved
schedule, bot, instructions, timeout, attachments and results destination.
Removing it with `github: null` restores the schedule. Manual runs remain available.

In the routine editor, choose **GitHub** under **Trigger**, enter `owner/name`,
select events and optionally enter comma-separated actions. Save, then copy
the webhook URL and the secret from the setup screen into the repository's
GitHub **Settings → Webhooks**. Choose `application/json` and the same events.
The secret appears only in that setup screen. Editing retains it without
returning it to the client; **Generate new secret** rotates it on Save and opens
a new setup screen. Cancel leaves the saved secret intact. GitHub setup is
available for saved bots; create a bot before configuring its webhook.

GitHub needs a reachable HTTPS receiver. The displayed base comes from the
existing `OMB_WEBHOOK_PUBLIC_URL` configuration; a loopback fixture URL is useful
only for local verification. Keep the webhook listener separate from the
control API when exposing it. This ticket does not provision a proxy or tunnel.

Example through the existing routine creation/update HTTP path:

```json
{
  "github": {
    "secret": "YOUR_NEW_RANDOM_SECRET",
    "repo": "owner/name",
    "events": ["push", "pull_request"],
    "actions": ["opened", "merged"]
  }
}
```

Creation requires a secret; updates may omit it to preserve the existing
secret. Repository matching ignores case. Events and actions match exactly.
An action filter applies to all configured events, so the example excludes
pushes, which have no action. Leave actions empty to accept pushes and every
PR action. `merged` matches GitHub's `pull_request` event with `action: closed`
and `pull_request.merged: true`; `closed` includes both merged and unmerged PRs.

Validation follows [GitHub's signature contract](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
and [event payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads):
HMAC-SHA256 over the exact raw bytes, using `X-Hub-Signature-256`, with a
constant-time digest comparison before JSON parsing. Missing/bad signatures
return 401 and create rejected entries in the existing attempt log. Invalid
signed JSON, event/delivery headers or payload shapes return 400. The existing
256 KiB ingress body limit returns 413. Only POST is accepted.

Signed filter mismatches, paused routines and registration pings return 200
without a run. Matching deliveries return 200 with `runId`. Their prompt appends
a bounded event summary to the routine's saved instructions, and run history
records `triggerSource: webhook`, the routine ID and `X-GitHub-Delivery`.
Attempts use the routine ID as `webhookId` and are exposed by `/api/webhooks`
under the same bot visibility rules as routines.

Delivery receipts share the existing seven-day retry ledger, survive restarts
and run-history pruning, and are committed atomically with the run. Unfinished
runs remain deduplicated beyond that window. Replays return the original run
ID without creating work. Three unfinished GitHub runs per routine or a full
retry ledger returns 429. Routine configuration and the attempt log are written
atomically with mode 0600. The secret is excluded from routine API responses
and live frames.

## Isolated acceptance

Follow [the shared fixture guide](README.md). Never send these requests to a
live workspace. The script launches `launchVerificationServer()` with a
temporary home/data directory, free control/webhook ports and the fake engine.
It calls the real routine HTTP API and signed ingress, awaits completed runs,
writes redacted JSON beside the retained server log, and stops its exact child
and removes temporary data even on failure.

```sh
node --experimental-strip-types scripts/verify-github-triggers.ts
pnpm exec vitest run server/github-webhook.test.ts server/github-triggers.e2e.test.ts server/webhook-ingress.test.ts server/webhooks.test.ts server/routines.test.ts server/routines-startup.test.ts server/webhook-idempotency.test.ts src/components/routines/RoutineViews.test.ts src/components/routines/cron-editor.test.ts src/lib/routine-calendar.test.ts src/lib/bot-creation-draft.test.ts
OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/github-routines-ui.e2e.test.ts
pnpm typecheck
```

The script's `cases` evidence proves:

- **a:** signed push completes one routine run; its saved prompt contains
  `owner/name`, `3 commits`, `main` and the head commit message. A bounded
  execution transcript and results-thread ID are retained.
- **b:** bad and missing signatures each return 401 with a rejected attempt;
  the run count remains one.
- **c:** repository and event mismatches return 200/ignored; the count stays one.
- **d:** the same delivery ID returns the original run ID/duplicate; count one.
- **e:** PR opened under a merged filter is ignored; changing to opened accepts
  it, completes a second run, and reuses the results destination.

The renderer fixture drives the real App through `control-omb ui`: creates a
GitHub routine, selects multiple events, obtains its once-visible secret,
signs a push, checks completed history, edits actions through PATCH, and
reopens the editor to prove the secret stays hidden and the URL persists.
It prints screenshots of the real run log and saved editor. Fixture cleanup
also closes its dedicated headless browser. No real GitHub repository,
provider account or external delivery is involved.
