# Telegram adapter verification

Everything runs against a disposable runtime and a fake Bot API
(`server/testing/fake-telegram.ts`); no real Telegram account, token or user
data is involved. See [docs/telegram.md](../telegram.md) for the feature.
Last executed in full on 2026-10-10 on branch `feat/messaging-adapters`
(worktree `.worktree/feat-messaging-adapters`, base `fork/main` @ `6ee5b14b`).

## Automated

```sh
pnpm exec vitest run server/messaging/telegram.test.ts server/messaging/telegram.e2e.test.ts
```

`server/messaging/telegram.test.ts` covers the client (the Bot API calls, the 4096 split,
MarkdownV2 fallback, no token in errors, getUpdates long-poll and offset
semantics against the fake), the binding store (0600, single-use and expiring
codes, transport and cursor persistence) and the service against a fake host.
The long-poll suite covers: default polling that relays pairing and turns
exactly like the webhook path, cursor persistence and restart-without-replay,
the 409 webhook-conflict error state and its recovery, and poller shutdown on
transport switch or service stop. Legacy bindings without a saved transport
also exercise webhook-status discovery, preservation of an active webhook,
polling when no webhook exists, lookup failures, and cancellation or restart
during discovery.

`server/messaging/telegram.e2e.test.ts` launches the real harness through
`launchVerificationServer`. The webhook case posts Telegram-shaped calls to
the real receiver: wrong secret gives 401, an unknown chat plus a pairing code
creates the binding, the next message's reply lands in the fake's outbox
addressed to that chat, a long answer is split, and unpairing stops replies.
The long-poll case creates a binding with no public URL, watches
`GET /<id>/poll` reach `polling`, pairs and relays a turn entirely through
`getUpdates`, checks the persisted cursor, switches the binding to webhook
delivery and back, surfaces a forced 409 conflict as the poller's `error`
state, and unbinds. Both write a `.log.telegram.json` receipt next to the
server log.

Executed 2026-10-10: `19 passed (19)` unit, `2 passed (2)` e2e; with
`pnpm typecheck` clean, `pnpm lint` 0 warnings, `pnpm i18n:check` valid.

## Browser check of the settings UI

Driven 2026-10-10 with headless Chromium (playwright-core 1.63.0 + the
pre-cached `chromium_headless_shell-1243`) against the launcher fixture
(`control-omb launch` with `TELEGRAM_API_BASE` pointed at the loopback fake)
and a Vite dev view of the real `<App/>` proxying to it. 18 textual checks,
all passing: the Messaging section mounts from the settings rail; the token
field is `type="password"` and empty before typing; after binding, the card
shows `@fake_omb_bot` with the live `Listening` badge and the token appears
nowhere in the page; `GET /api/messaging/telegram` returns no token; the
bindings file is mode 0600; a pairing code generated in the UI pairs a chat
delivered through the real webhook ingress; the paired chat (name + thread)
appears with working Mute and Unpair controls; Unbind (with its confirm
dialog) returns the section to the bind form and removes the binding
server-side. No screenshots were captured; the assertion transcript lives
with the branch's delivery report.

## By hand against a launched fixture

```sh
node --experimental-strip-types server/testing/fake-telegram.ts          # prints FAKE url
TELEGRAM_API_BASE=<FAKE url> node --experimental-strip-types scripts/control-omb.ts launch   # prints URL
node --experimental-strip-types scripts/verify-telegram.ts --url <URL> --fake <FAKE url>
```

Without flags `scripts/verify-telegram.ts` launches both itself. It prints the
evidence JSON (binding, 401s, pairing exchange, the outbox reply, and the
transcript line it came from) and exits non-zero on the first failed check.
Stop the launcher and the fake with Ctrl-C afterwards.
