# Spaces

Spaces are authorization boundaries. Every bot, computer, routine, webhook and
page belongs to exactly one space; a thread belongs to its bot's space. One
function, `assertSpace(scope, entitySpaceId)` in `server/space-scope.ts`,
refuses a cross-space access by throwing `SpaceIsolationError`, which the HTTP
layer answers as `403 {"error": "...", "code": "space_isolation", "space": "<the entity's space>"}`.

## Model

- A default space, `personal`, always exists and cannot be deleted. Entities
  with no assignment are in it, and on first load every existing bot and team
  computer is written into it, so nothing changes until a second space exists.
  Pages created before spaces (`spaceId: "default"`) are migrated to `personal`.
- Storage is `spaces.json` (mode 0600) in the data directory. A damaged file
  stops the server rather than silently dropping isolation.
- Routines and webhooks follow their bot unless assigned explicitly. Threads
  always follow their bot. Rooms are not assigned and stay in `personal`.

## Who is bound

The loopback owner (the single-operator model) is unrestricted and sees every
space; nothing about their requests changes. Isolation binds:

- **Scoped requests.** A caller can narrow itself with `x-omb-space: <id>`; the
  header can never widen anything. The same scope applies to a Telegram
  binding, a page chat or any future non-owner actor that is given a scope.
  Reading a bot, thread, routine, webhook, page or computer outside the scope
  is `403 space_isolation`. `GET /api/bots` and `GET /api/pages` return only
  the scope's entities, and spaces cannot be managed from a scope.
- **Entity-to-entity references.** `peerAllowed` (and so the roster, `list_bots`,
  @mention resolution, `ask_bot` and `delegate_bot`) refuses a bot in another
  space unless that direction of space pair is on the allowlist. A page chat or
  proposal binds a bot only to a page in its own space. A bot uses a team or
  shared computer only from its own space.

The one request-level check lives next to the bot-visibility check in
`server/index.ts` (`guardRequest`), so any request naming an entity touches the
chokepoint once.

## API (admin, from outside any scope)

- `GET /api/spaces` → `{ spaces, assignments, allowlist }`
- `POST /api/spaces {name}`, `PATCH /api/spaces/:id {name}`, `DELETE /api/spaces/:id` (only when empty)
- `PUT /api/spaces/assign {kind, id, spaceId}` — kind is bot, computer, routine, webhook or page
- `POST|DELETE /api/spaces/allowlist {from, to}` — allow bots in `from` to reach bots in `to`

## UI

The sidebar shows a space switcher once a second space exists (and a "New
space" link before). It filters the bot list by space and is remembered per
browser. Bot settings → Access has a Space picker.

Verification: [docs/verification/spaces.md](verification/spaces.md).
