# Discord — verification record

All runs on branch `feat/messaging-adapters`, worktree
`/workspace/projects/openmausbot/.worktree/feat-messaging-adapters`, against
fakes only. No real Discord server, token, or message took part: the fixture
launcher (`scripts/control-omb.ts`) forwards `DISCORD_API_BASE` to the child
server only when it is a loopback URL (`http://127.0.0.1:<port>`), and
`server/testing/fake-discord.ts` serves the REST API + gateway WebSocket.

## 2026-10-11 — unit, e2e, typecheck, lint, i18n

Commands (node 24 toolchain in PATH):

```
node node_modules/vitest/vitest.mjs run server/messaging/discord.test.ts server/messaging/discord.e2e.test.ts
node node_modules/typescript/bin/tsc -b && node node_modules/typescript/bin/tsc -p tsconfig.server.json
node node_modules/oxlint/oxlint --deny-warnings .
node scripts/generate-locale.mjs --check
```

Results: 13 Discord unit tests + 1 Discord runtime e2e green (whole messaging
battery together: 44 unit, 4 e2e, 6 component — 54 total);
server + app typecheck clean; lint clean (0 warnings); locale catalogs valid.

What the e2e proves, end to end through the real harness (fake CLI engine,
fake Discord):

1. Bind refusal paths: a bad token → 400 (401) with the token absent from the
   message; an unknown bot → 404.
2. A valid bind stores the token (0600 file), records the bot identity from
   `GET /users/@me`, proves the gateway with a throwaway identify, and the
   service's socket state reaches `connected` (READY received).
3. List/read responses never contain the token.
4. Pairing by DM: wrong guess → "didn't match"; the API-issued 6-digit code →
   "Paired with …", chat stored with `discord:900…` identity.
5. A paired DM's question reaches the bot (relayed turn in the thread) and
   "Four." comes back through `POST /channels/:id/messages` to that DM only.
6. Unpair stops replies; unbind closes the gateway socket (fake socket count
   reaches 0).

Unit coverage highlights: identify → READY (state, identity), heartbeats sent
on the hello interval with ACKs; guild messages, own echoes, and muted DMs
ignored; deterministic sendIds from the message snowflake; abrupt socket
drops and gateway reconnect requests (op 7) reconnect with a fresh identify;
a dead token (401) is a terminal `error` state with on-demand recovery.

## 2026-10-11 — browser check of the Messaging settings UI (textual)

Headless Chromium (playwright-core, chrome-headless-shell) against the real
harness UI (vite dev server proxying to the fixture server) with the fake
Discord. Transcript: `discord-ui-e2e-transcript-2026-10-11.txt` (task
workspace) — 16/16 checks: all three platform headings render; the Discord
form is one write-only password input, never prefilled; a UI bind shows the
card "Discord · @fake_omb_bot" with a "Connected" badge; the token never
appears in the UI, the admin API, or logs (file is 0600 and holds it
privately); the pairing code is generated in the UI and, delivered as a DM
through the fake's /push test aid, pairs the DM; Mute/Unpair/Unbind all work
through the card, and unbind removes the binding server-side.

Docs pulled 2026-10-11 while writing the adapter (context7 unavailable;
official docs instead):
- https://docs.discord.com/developers/topics/gateway
- https://docs.discord.com/developers/topics/gateway-events
- https://docs.discord.com/developers/resources/message

Unverified against the real platform: nothing has touched discord.com — real
application setup (bot + MESSAGE CONTENT intent toggle), gateway URLs, and
DM delivery need one run with Clauber's token (see the request list).
