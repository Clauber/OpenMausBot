# Slack

Reach a bot from Slack: send it a direct message, get its answer back in the
DM. Each Slack app is bound to one OpenMausBot bot, each DM joins by a
one-time pairing code, and inbound events arrive over Socket Mode — one
outbound WebSocket per binding, so no public URL is ever needed.

Messages enter the bot through the same guarded-send path as
[guarded external messages](verification/guarded-messages.md), so approval
modes and admission rules are unchanged. The words are stored as relayed lines
(`relayed: true`), and the turn is booked in the usage ledger as
"Slack · <@user>". If the bot needs an approval, the DM is told so; approve it
in the app and the answer follows.

## Setup

1. Create the Slack app at [api.slack.com/apps](https://api.slack.com/apps)
   (from scratch, in your workspace):
   - **Socket Mode**: On. This is what makes the inbound connection outbound.
   - **OAuth & Permissions → Bot Token Scopes**: `chat:write`, `im:history`,
     `im:read`. Install the app to the workspace.
   - Keep both tokens: the app-level token (**Basic Information → App-Level
     Tokens**, with the `connections:write` scope, looks like `xapp-1-…`) and
     the bot token (**OAuth & Permissions**, looks like `xoxb-…`).
2. Bind it in the app: open the bot's settings → **Messaging**, paste both
   tokens, and **Bind Slack**. (The same actions exist as an admin API,
   below — the UI is the intended path.) The server checks the bot token with
   `auth.test`, proves Socket Mode works with a throwaway
   `apps.connections.open`, stores both tokens in
   `<data dir>/messaging/slack.json` (mode 0600, never returned by any API),
   and opens the Socket Mode WebSocket. The URL is temporary by design — a
   fresh one is fetched on every (re)connect, and `hello`, `disconnect`
   (`refresh_requested`, `warning`, `link_disabled`) envelopes drive the
   reconnect loop with capped backoff.
3. Pair a DM: in **Messaging**, press **New pairing code** (or
   `POST /api/messaging/slack/<id>/pairing`) for a 6-digit code valid 10
   minutes. In Slack, open a DM with the app and send the code. The
   conversation is bound, gets its own task named `Slack · <@user>`, and
   everything sent there goes to that task. The code works once; ten wrong
   guesses burn it.

## Behavior and limits

- One Socket Mode connection per binding. Envelopes are acknowledged
  immediately on receipt; each message's turn uses a send id derived from the
  binding and the message's `ts`, so a redelivered envelope (or a restart)
  cannot start the same turn twice.
- Only direct messages are handled (`message` events with
  `channel_type: "im"`). The app's own echoes (`bot_id` or its own user id)
  and edit/unfurl subtypes are ignored. Threads and channels inside LEGION
  are deliberately out of scope for now.
- Replies go out with `chat.postMessage`. Slack accepts long texts but
  truncates over 40,000 characters; replies are sent whole, no splitting.
- Config mistakes surface as a socket `error` state (visible in **Messaging**
  and the admin API): an invalid bot token (`invalid_auth`) or Socket Mode
  switched off (`not_allowed_token_type`, `link_disabled`) stop retrying
  until the binding is re-bound; everything else (network drops,
  `refresh_requested`) reconnects automatically.
- `SLACK_API_BASE` (default `https://slack.com/api`) overrides the Web API
  origin. Tests and the fixture point it at a loopback fake; the fixture
  launcher forwards it only when it is `http://127.0.0.1:<port>`.

Verification: [verification/slack.md](verification/slack.md).
