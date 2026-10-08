# Inbox and Slack pre-check

`pam-triage.py` is a deployment-specific, read-only delta scanner for the three
existing Gmail gateway containers on CT110 and GSD/JUMP Slack. Felt Right is
excluded. It requires Python 3, the existing `proxmox` SSH host/key, and the
designated Slack credentials in `~/ai/.env`. It installs nothing remotely.

Gmail's existing MCP searches expose at most 100 results and no page argument.
The scanner reuses their backing `gog` v0.43.0 installations in `gog-mcp`,
`gog-mcp-cklauber`, and `gog-mcp-clauber93`. A fixed Node helper runs through
`docker exec` and invokes only Gmail v1 `users.messages.list` and
`users.messages.get`, with `--readonly`, `--gmail-no-send` and the Gmail
read-only scope. OAuth credentials remain inside those containers. It lists
every unread ID before fetching metadata for previously unseen IDs.
Each container's configured default account was verified against its MCP
account; personal email addresses and OAuth credentials are not embedded here.

Slack reads only `client.counts`, `conversations.info`, and paginated
`conversations.history`. Browser-session authentication uses
`SLACK_MCP_XOXC_TOKEN_GSD`, `SLACK_MCP_XOXC_TOKEN_JUMP`, and
`SLACK_MCP_XOXD_TOKEN`. Values are never logged, passed in process arguments,
or saved in state. Muted channels are included. The existing Slack MCP's
`client.counts` contract was verified against the deployed service and live
responses on 2026-10-07. It is an internal Slack API and may change. Missing
schema, inaccessible messages, unread thread replies, or mentions in unjoined
channels fail open, because the counts endpoint cannot identify those items
completely. The full routine remains responsible for them.

The script never marks read, sends, joins, reacts, archives or deletes.
Every source must complete; partial results produce no success JSON and do not
advance state. A lock prevents concurrent state writers; successful output is
flushed before an atomic state replacement. Previously reported IDs stay seen
even if an item is subsequently marked unread again. Exactly-once consumption
across script output, cancellation and bot completion is not guaranteed by
this pre-check protocol. The bot rechecks the actual sources when it wakes.

For a read-only comparison, use a separate shadow state file:

```sh
python3 /absolute/repo/scripts/routine-prechecks/pam-triage.py \
  --state-file /absolute/private/triage-shadow-seen.json --dry-run
```

`--dry-run` does not create or advance state. A normal invocation advances only
its own local seen-state after reporting all items. Start with an empty state
to see the existing unread backlog. Do not silently seed a production state
from unread IDs: review how the backlog was handled during the shadow comparison.
Large initial backlogs may exceed the scheduler's time/output/item budget,
causing normal bot dispatch rather than a quiet skip. There is no partial
classification or automatic state bootstrap.

After a full business day's comparison and owner approval, the routine can
point at the script through its reviewed `preCheck` configuration:

```json
{
  "preCheck": {
    "command": "/usr/bin/python3",
    "args": ["/absolute/repo/scripts/routine-prechecks/pam-triage.py", "--state-file", "/absolute/private/triage-seen.json"],
    "timeoutMs": 60000
  }
}
```

Keep the existing cron and timezone. The separate `routineWake` switch in
Settings starts off; switching it on only adds classification of a complete,
nonempty scan. Empty scans skip independently. Manual **Run now** bypasses
the pre-check. This document does not attach a script to any live routine.

Verification:

```sh
python3 -m unittest discover -s scripts/routine-prechecks -p 'test_*.py' -v
pnpm exec vitest run server/routine-precheck.test.ts server/routines-precheck.test.ts server/decider/routine-wake.test.ts server/routines-precheck.e2e.test.ts
```

Source contracts checked on 2026-10-07: deployed `gog api call --help`,
[Gmail message listing](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list),
[Gmail metadata](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get),
[Slack conversation history](https://docs.slack.dev/reference/methods/conversations.history/),
and the [Slack MCP unread implementation](https://github.com/korotovsky/slack-mcp-server/blob/master/pkg/handler/conversations.go).
