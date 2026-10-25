# Telegram

Reach a bot from Telegram: send it a direct message, get its answer back in
the chat. Each Telegram bot is bound to one OpenMausBot bot, each chat joins
by a one-time pairing code, and inbound updates arrive by getUpdates
long-polling by default — no public URL needed. A binding can switch to
webhook delivery instead when a public HTTPS receiver is available.

Messages enter the bot through the same guarded-send path as
[guarded external messages](verification/guarded-messages.md), so approval
modes and admission rules are unchanged. The words are stored as relayed lines
(`relayed: true`), and the turn is booked in the usage ledger as
"Telegram · <first name>". If the bot needs an approval, the chat is told so;
approve it in the app and the answer follows.

## Setup

1. Create the Telegram bot: message [@BotFather](https://t.me/BotFather),
   `/newbot`, and keep the token (`123456:ABC...`).
2. Bind it in the app: open the bot's settings → **Messaging**, paste the
   token, and **Bind Telegram**. (The same actions exist as an admin API,
   below — the UI is the intended path.) The server checks the token with
   `getMe`, stores it in `<data dir>/messaging/telegram.json` (mode 0600,
   never returned by any API), and starts a getUpdates long-poll loop:
   it deletes any webhook on the token first (the Bot API allows one delivery
   mode per token), then holds each `getUpdates` request open for up to 50
   seconds. Nothing needs to be reachable from the internet.
3. Pair a chat: in **Messaging**, press **New pairing code** (or
   `POST /api/messaging/telegram/<id>/pairing`) for a 6-digit code valid 10
   minutes. In Telegram, open your bot and send the code (or `/start <code>`).
   The chat is bound, gets its own task named `Telegram · <name>`, and
   everything it sends goes to that task. The code works once; ten wrong
   guesses burn it.

### Webhook delivery (optional)

Where a public HTTPS receiver exists (`OMB_WEBHOOK_PUBLIC_URL`; the receiver
listens on `OMB_WEBHOOK_PORT`, default: harness port + 1), a binding can
deliver by webhook instead: **POST /api/messaging/telegram/<id>/webhook**
with `{publicBaseUrl}` registers
`https://<base>/hooks/telegram/<bindingId>` with a random secret; Telegram
sends the secret back on every call as `X-Telegram-Bot-Api-Secret-Token` and
anything without it gets 401. **DELETE …/webhook** deletes the registration
and returns the binding to polling. Creating a binding with `publicBaseUrl`
starts on webhook delivery directly (and fails loudly if Telegram refuses the
URL, instead of silently polling).

## Admin API

All under `/api/messaging/telegram`, admin scope (loopback is the owner).
Tokens and secrets are never returned after creation.

| Request | Does |
| --- | --- |
| `GET /` | list bindings, their chats, transport and pairing state |
| `POST /` `{botId, token, markdown?, publicBaseUrl?}` | create a binding (poll by default, webhook with `publicBaseUrl`) |
| `GET /<id>` | one binding |
| `DELETE /<id>` | remove it, stop its poller, and delete the Telegram webhook |
| `POST /<id>/pairing` | new single-use code |
| `GET /<id>/poll` | transport + live poller state (`starting`/`polling`/`backing-off`/`error`/`stopped`) |
| `POST /<id>/poll` | (re)start the poller after an error |
| `GET /<id>/webhook` | Telegram's `getWebhookInfo` |
| `POST /<id>/webhook` `{publicBaseUrl}` | switch to webhook delivery (stops the poller) |
| `DELETE /<id>/webhook` | delete the webhook, return to polling |
| `PATCH /<id>/chats/<chatId>` `{enabled}` | mute or unmute a chat |
| `DELETE /<id>/chats/<chatId>` | unpair a chat |

Bindings live in `<data dir>/messaging/telegram.json` (mode 0600, it holds
the token and the delivery state). The poll cursor (`pollOffset`) is persisted
with the binding, so a restart resumes where polling left off instead of
replaying answered updates. For older bindings without a transport field, the
server reads Telegram webhook status before choosing delivery. An active webhook
stays registered; an empty webhook URL resumes polling without deleting a webhook.
A failed lookup leaves delivery unresolved and reports a poller error. Restart
the server to retry discovery, or use the polling endpoint to explicitly select
polling. Newly created bindings save their transport explicitly.

## Behaviour and limits

- Private chats and text messages only. Groups, channels, photos, voice and
  files are ignored or answered with a short "text only" note.
- One message at a time per chat: a second message while the first is running
  is answered "still working".
- Replies go out as plain text, split at Telegram's 4096-character limit on
  paragraph, line or word boundaries. Set `markdown: true` on the binding to
  send MarkdownV2; a part Telegram rejects with 400 is resent as plain text.
- "typing" is shown every few seconds while the turn runs. A turn that is
  still unfinished after 30 minutes gets a "check the app" note.
- The chat's task keeps whatever approval mode it has: Full access runs with
  Full access, Ask asks. Like the guarded route, an Ask task that carries
  remembered permissions refuses external messages, and the chat is told why.
- One poller per Telegram token — the Bot API refuses concurrent `getUpdates`
  for the same bot, and LEGION runs a single server, so this is not contended.
  A poller that meets Telegram's 409 "webhook is active" conflict surfaces as
  an `error` state in the API and UI until it is restarted after the conflict
  is cleared; 429s and network faults back off exponentially (1 s doubling to
  60 s) and recover on their own.
- Deterministic send ids (derived from the update id) mean Telegram
  redelivering an update — or a poller replaying one crash-window wide of the
  saved cursor — cannot start the same turn twice.
- `TELEGRAM_API_BASE` (default `https://api.telegram.org`) overrides the Bot
  API origin. Tests and the fixture point it at a loopback fake; the fixture
  launcher forwards it only when it is `http://127.0.0.1:<port>`.

Verification: [verification/telegram.md](verification/telegram.md).
