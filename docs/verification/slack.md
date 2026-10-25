# Slack — verification record

All runs on branch `feat/messaging-adapters`, worktree
`/workspace/projects/openmausbot/.worktree/feat-messaging-adapters`, against
fakes only. No real Slack workspace, token, or message took part: the fixture
launcher (`scripts/control-omb.ts`) forwards `SLACK_API_BASE` to the child
server only when it is a loopback URL (`http://127.0.0.1:<port>`), and
`server/testing/fake-slack.ts` serves the Web API + Socket Mode link.

## 2026-10-11 — unit, e2e, typecheck, lint, i18n

Commands (node 24 toolchain in PATH):

```
node node_modules/vitest/vitest.mjs run server/messaging/slack.test.ts server/messaging/slack.e2e.test.ts
node node_modules/typescript/bin/tsc -b && node node_modules/typescript/bin/tsc -p tsconfig.server.json
node node_modules/oxlint/oxlint --deny-warnings .
node scripts/generate-locale.mjs --check
```

Results: 12 Slack unit tests + 1 Slack runtime e2e green (together with the
Telegram suites: 31 unit, 3 e2e); server + app typecheck clean; lint clean
(0 warnings); locale catalogs valid.

## 2026-10-11 — browser check of the Messaging settings UI (textual)

Headless Chromium (playwright-core, chrome-headless-shell) against the real
harness UI (vite dev server proxying to the fixture server) with the fake
Slack. Transcript:
`slack-ui-e2e-transcript-2026-10-11.txt` (task workspace) — 16/16 checks:

1. Settings → Messaging lists both platforms (Telegram, Slack headings).
2. Slack bind form: two write-only password inputs, never prefilled.
3. UI bind with the fake tokens → card shows "Slack · Fake Workspace" with a
   "Connected" socket badge; tokens are not displayed afterwards (form gone,
   no token text in the card).
4. `GET /api/messaging/slack` never returns either token; `slack.json` is
   mode 0600 and holds both tokens privately.
5. New pairing code through the UI; the code delivered as a DM (via the
   fake's /push test aid) pairs the DM; the paired row appears with Mute /
   Unpair / Unbind Slack.
6. Mute toggles to Unmute (PATCH persisted), Unpair removes the row, Unbind
   (after the confirm dialog) returns the bind form and removes the binding
   server-side.

One defect was found and fixed during this pass: the Slack API names a
conversation by its `channelId` while the shared card addresses chats by
`chatId`, so Mute/Unpair hit `/chats/undefined`. `refresh()` now normalizes
`channelId` → `chatId` when reading the Slack list (the API keeps Slack's
naming).

What the e2e proves, end to end through the real harness (fake CLI engine,
fake Slack):

1. Bind refusal paths: a wrong bot token → 400 `invalid_auth`, a wrong app
   token → 400 `not_allowed_token_type`, an unknown bot → 404 — and neither
   error message contains either token.
2. A valid bind stores both tokens (0600 file), records team/user from
   `auth.test`, and the service's Socket Mode state reaches `connected`.
3. List/read responses never contain either token.
4. Pairing by DM: wrong guess → "didn't match"; the API-issued 6-digit code →
   "Paired with …", chat stored with `slack:U…` identity.
5. A paired DM's question reaches the bot (relayed turn in the thread) and
   "Four." comes back through `chat.postMessage` to that DM only.
6. Unpair stops replies; unbind drops the Socket Mode connection (fake socket
   count reaches 0).

Unit coverage highlights: deterministic sendIds from the message `ts`
(a redelivered envelope cannot double-start a turn); acks recorded for every
delivered envelope; own echoes, edits, non-`im` events and muted DMs ignored;
`refresh_requested` → automatic reconnect; `link_disabled` and token errors →
terminal `error` state with on-demand recovery.

Docs pulled 2026-10-10 while writing the adapter (context7 unavailable;
official docs instead):
- https://docs.slack.dev/apis/events-api/using-socket-mode.md
- https://docs.slack.dev/reference/methods/apps.connections.open.md
- https://docs.slack.dev/reference/methods/chat.postmessage.md
- https://docs.slack.dev/reference/methods/auth.test.md

Unverified against the real platform: nothing has touched slack.com — real
app setup, scope names as Slack accepts them today, and DM delivery need one
run with Clauber's tokens (see the request list).
