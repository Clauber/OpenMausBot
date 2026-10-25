# Approval rules, automatic review and effect receipts

Legion applies action rules before its approval-level fallback. Owners and
admins can edit a bot's **Permissions → Approval rules** section, or PATCH
`/api/bots/:id` with `approvalRules`. Workspace defaults are stored by
`PATCH /api/config` with the same field. Invalid selectors/decisions return
400; members cannot edit these grants (403). `null` removes bot rules;
`{}` clears workspace defaults. `GET /api/bots/:id/approval-rules` returns
both scopes.

```json
{
  "approvalRules": {
    "readOnlyExempt": true,
    "categories": { "send-like": "require_approval", "destructive": "require_approval" },
    "tools": { "native:Read": "always_allow", "mcp:mail:send_email": "require_approval" }
  }
}
```

Selectors are exact, case-sensitive tool names or `native:Tool` /
`mcp:server:tool` identities from `shared/tool-scope.ts`. Wildcards are
rejected. Categories are `read`, `write`, `network`, `send-like`,
`destructive`, and `financial`. Classification uses the existing outbound
send taxonomy and native/MCP identities, with read verbs taking priority.
Known agents management tools preserve their advertised identity and classify
delete/remove action arguments as destructive. Unknown tools are writes.
This is a tool-name taxonomy, not an interpreter
of arbitrary shell commands or opaque remote code.

## Precedence

| Condition | Result |
| --- | --- |
| Bot exact tool rule | Wins over bot category and workspace defaults |
| Bot category rule | Wins over workspace tool/category defaults |
| Workspace exact tool rule | Wins over workspace category |
| Explicit requirement in any expanded connector batch child | Requires approval even with an outer grant |
| Unmatched read, read-only exemption enabled (default) | Always allow |
| Unmatched other tool, or exemption disabled | Existing approval level/policy decides |
| `require_approval` | Shows a card even in Auto or Full |
| `always_allow` | Grants at the harness gate, subject to access, judge and accounting |

Questions are never answered automatically. Rules do not grant tool access,
connector scopes, credentials, team ownership or computer permissions.
Send-like grants still reserve outbound counts, enforce configured daily
allowance caps, and record decision-log receipts. A human denial remains a
denial.

Rules cover connector dispatch, mapped harness configuration/coordination
actions, browser/computer dispatch, and native permission requests delivered
to the harness. **Native tools a CLI provider approves internally do not
produce a permission request and cannot be intercepted by this layer.**
The provider's existing approval mode is preserved for unmatched actions.
Use a provider mode that surfaces the relevant native permissions when a
native rule must be enforced. This layer does not promise interception of
every native action in a permissive provider mode.

## Automatic review

Consequential categories (`send-like`, `destructive`, `financial`) call the
existing Jev decider client with job `autoReview`, sharing its configured
URL/model, credentials, enablement, timeout and response validation.
`decider.jobs.autoReview: false` disables the judge. No separate model or
credential is introduced.

The judge receives the tool, a redacted bounded argument summary (2,000
characters), and the thread title (500 characters). Its strict choice is
`allow`, `ask` or `deny`, with the existing client's `pTop` probability as
confidence. Below 0.8, every choice becomes `ask`. A confident denial refuses
dispatch; `ask` always shows a card, including for an `always_allow` rule.
An `allow` does not override an explicit requirement or the existing
outbound confirmation policy. At native Auto it can approve a surfaced
permission. Disabled, unavailable, invalid or timed-out responses fall back
to the existing rule/approval policy.

Decision-log rows include confidence, a one-line explanation derived from
the validated verdict, and `source: auto-review`. Approval cards carry the
review result. The client returns choices/probabilities rather than generated
free-form reasoning; the explanation is therefore a stable verdict summary.

## Effect ledger

`data/approval-effects.sqlite` (within the configured data directory) is
created with mode 0600. SHA-256 keys include bot, exact tool, normalized JSON
arguments, thread and turn. Object keys are sorted; array order and values
are preserved. A different turn is a different effect identity. Connector
batches claim both the outer key and each consequential child key atomically;
duplicate children are refused before dispatch.

Claims are durable immediately before dispatch/approval delivery, and
approval cards retain their effect key. A repeated key, including an already
approved card retry, returns HTTP 409 with `{"code":"effect_replayed"}`.
Native duplicate permission proposals receive a denial instead of an HTTP
response. Concurrent claims and restarts cannot re-authorize the same key.
Ledger errors fail closed for consequential actions.

A claim means dispatch was authorized, not that the remote effect completed.
It is deliberately retained after a failed/uncertain dispatch: the remote
side might already have acted. Retrying identical arguments in the same turn
is consequently refused even after such a failure. Opaque connector code
has one envelope key; arbitrary effects inside that code cannot be enumerated.

See the [isolated verification recipe](verification/approval-rules.md).
