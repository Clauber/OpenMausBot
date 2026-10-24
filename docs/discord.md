# Discord

Reach a bot from Discord: send it a direct message, get its answer back in
the DM. Each Discord application's bot is bound to one OpenMausBot bot, each
DM joins by a one-time pairing code, and inbound messages arrive over the
Discord gateway — one outbound WebSocket per binding, so no public URL is
ever needed.

Messages enter the bot through the same guarded-send path as
[guarded external messages](verification/guarded-messages.md), so approval
modes and admission rules are unchanged. The words are stored as relayed lines
(`relayed: true`), and the turn is booked in the usage ledger as
"Discord · <@user>". If the bot needs an approval, the DM is told so; approve
it in the app and the answer follows.

## Setup

1. Create the application at the [Discord developer portal](https://discord.com/developers/applications):
   - **Bot** tab: create the bot, keep the token, and enable
     **MESSAGE CONTENT INTENT** (not strictly required for DMs the bot
     receives, but enabling it avoids surprises later; it is privileged, so
     the toggle is deliberate).
   - No OAuth URL, no webhook, no inbound port is needed.
2. Bind it in the app: open the bot's settings → **Messaging**, paste the
   token, and **Bind Discord**. (The same actions exist as an admin API,
   below — the UI is the intended path.) The server checks the token with
   `GET /users/@me`, proves the gateway is reachable with a throwaway
   `GET /gateway/bot`, stores the token in
   `<data dir>/messaging/discord.json` (mode 0600, never returned by any
   API), opens the gateway WebSocket, and identifies with only the
   `DIRECT_MESSAGES` intent — guilds and servers are never subscribed.
   Heartbeats run on the gateway's schedule; a missed heartbeat
   acknowledgement is treated as a dead connection and reconnected.
3. Pair a DM: in **Messaging**, press **New pairing code** (or
   `POST /api/messaging/discord/<id>/pairing`) for a 6-digit code valid 10
   minutes. In Discord, DM the bot the code. The conversation is bound, gets
   its own task named `Discord · <@user>`, and everything sent there goes to
   that task. The code works once; ten wrong guesses burn it.

## Behavior and limits

- Only DMs are handled (`MESSAGE_CREATE` without a `guild_id`); guild
  messages, group DMs' threads-style flows, the bot's own echoes, and other
  events are ignored. Server-side channels/threads inside LEGION are
  deliberately out of scope for now.
- Replies go out with `POST /channels/:id/messages`, split at Discord's
  2000-character limit, in order, losing nothing. While a turn runs, the
  typing indicator is kept up (`POST /channels/:id/typing`).
- Each turn uses a send id derived from the binding and the message's
  snowflake id, so a redelivered event cannot start the same turn twice.
  Gateway events are not replayed after a reconnect: messages sent while the
  connection was down are picked up from the next message onward.
- A dead token surfaces as a socket `error` state (visible in **Messaging**
  and the admin API) instead of retrying forever; network drops and gateway
  reconnect requests reconnect automatically with capped backoff.
- `DISCORD_API_BASE` (default `https://discord.com/api/v10`) overrides the
  REST origin. Tests and the fixture point it at a loopback fake; the fixture
  launcher forwards it only when it is `http://127.0.0.1:<port>`.

Verification: [verification/discord.md](verification/discord.md).
