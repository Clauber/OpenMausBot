# Telegram adapter verification

Everything runs against a disposable runtime and a fake Bot API
(`server/testing/fake-telegram.ts`); no real Telegram account, token or user
data is involved. See [docs/telegram.md](../telegram.md) for the feature.

## Automated

```sh
pnpm exec vitest run server/messaging/telegram.test.ts server/messaging/telegram.e2e.test.ts
```

`server/messaging/telegram.test.ts` covers the client (all six Bot API calls, the 4096 split,
MarkdownV2 fallback, no token in errors), the binding store (0600, single-use
and expiring codes) and the service against a fake host. `server/messaging/telegram.e2e.test.ts`
launches the real harness through `launchVerificationServer`, creates a
binding, and posts Telegram-shaped webhook calls to the real receiver: wrong
secret gives 401, an unknown chat plus a pairing code creates the binding, the
next message's reply lands in the fake's outbox addressed to that chat, a long
answer is split, and unpairing stops replies. It writes a
`.log.telegram.json` receipt next to the server log.

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
