# Telegram

Reach a bot from Telegram: send it a direct message, get its answer back in the
chat. Inbound is webhook-only (Telegram calls your server; nothing polls), each
chat joins by a one-time pairing code, and each Telegram bot is bound to one
OpenMausBot bot.

Messages enter the bot through the same guarded-send path as
[guarded external messages](verification/guarded-messages.md), so approval modes
and admission rules are unchanged. The words are stored as relayed lines, and
the turn is booked in the usage ledger as "Telegram · <first name>". If the
bot needs an approval, the chat is told so; approve it in the app and the
answer follows.

## Setup

1. Create the Telegram bot: message [@BotFather](https://t.me/BotFather),
   `/newbot`, and keep the token (`123456:ABC...`).
2. Make the webhook receiver reachable over public HTTPS. It listens on
   `OMB_WEBHOOK_PORT` (default: harness port + 1); put a tunnel or proxy in
   front and set `OMB_WEBHOOK_PUBLIC_URL` to its base, e.g.
   `https://bots.example.com`. Telegram only delivers to HTTPS on 443, 80, 88
   or 8443.
3. Create the binding (loopback, or an admin session):

   ```sh
   curl -s -X POST http://127.0.0.1:8799/api/messaging/telegram \
     -H 'content-type: application/json' -H 'origin: http://127.0.0.1:8799' \
     -d '{"botId":"<bot id>","token":"<token>","publicBaseUrl":"https://bots.example.com"}'
   ```

   The server checks the token with `getMe`, generates a random webhook secret,
   and (with `publicBaseUrl`) registers
   `https://bots.example.com/hooks/telegram/<bindingId>` with Telegram and that
   secret. The response shows the secret once; Telegram sends it back on every
   call as `X-Telegram-Bot-Api-Secret-Token`, and anything without it gets 401.
   Without `publicBaseUrl`, register it yourself:
   `POST /api/messaging/telegram/<id>/webhook {"publicBaseUrl": "https://..."}`.
4. Pair a chat: `POST /api/messaging/telegram/<id>/pairing` returns a 6-digit
   code valid for 10 minutes. In Telegram, open your bot and send the code (or
   `/start <code>`). The chat is bound, gets its own task named
   `Telegram · <name>`, and everything it sends goes to that task. The code
   works once; ten wrong guesses burn it.

## Admin API

All under `/api/messaging/telegram`, admin scope (loopback is the owner).
Tokens and secrets are never returned after creation.

| Request | Does |
| --- | --- |
| `GET /` | list bindings, their chats and pairing state |
| `POST /` `{botId, token, markdown?, publicBaseUrl?}` | create a binding |
| `GET /<id>` | one binding |
| `DELETE /<id>` | remove it and delete the Telegram webhook |
| `POST /<id>/pairing` | new single-use code |
| `GET /<id>/webhook` | Telegram's `getWebhookInfo` |
| `POST /<id>/webhook` `{publicBaseUrl?}` | (re)register the webhook |
| `DELETE /<id>/webhook` | delete the webhook |
| `PATCH /<id>/chats/<chatId>` `{enabled}` | mute or unmute a chat |
| `DELETE /<id>/chats/<chatId>` | unpair a chat |

Bindings live in `<data dir>/messaging/telegram.json` (mode 0600, it holds the
token).

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
- `TELEGRAM_API_BASE` (default `https://api.telegram.org`) overrides the Bot
  API origin. Tests and the fixture point it at a loopback fake; the fixture
  launcher forwards it only when it is `http://127.0.0.1:<port>`.

Verification: [verification/telegram.md](verification/telegram.md).
