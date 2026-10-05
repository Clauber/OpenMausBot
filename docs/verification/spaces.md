# Spaces verification

Use Node 24 or later and an isolated fixture. Never target live workspace data.
The driver uses `launchVerificationServer` from `control-omb`, which owns a
throwaway home, data directory, free port pair and the repository fake engine.

```sh
pnpm typecheck
pnpm exec vitest run server/space-scope.test.ts server/routes/spaces.test.ts \
  server/pages-db.test.ts server/routes/pages.test.ts server/peer-roster.test.ts
node --experimental-strip-types scripts/verify-spaces.ts
```

The unit test covers first-load migration, administration (delete only when
empty), the chokepoint, cross-space @mention/delegation and computer refusal.
The driver runs the real route table:

- Two spaces; a bot in each; pages in each; the default space is `personal`.
- A request scoped with `x-omb-space` to Work lists only Work's bot and pages.
  Reading Personal's thread, tasks, page, the Personal page list, or binding a
  Personal page to a Work bot is `403` with `code: "space_isolation"`.
- Spaces cannot be managed from a scope.
- A Work bot completes a normal turn through the fake engine and its reply is
  readable from the Work scope; a Work page chat binds a Work bot.
- A Personal bot's `/api/internal/agents` roster omits the Work bot until the
  Personal→Work pair is allowlisted, and omits it again once revoked.
- Deleting a non-empty space or the default space is `409`; an empty one deletes.

Evidence (method, path, scope, status, JSON) is written next to the fixture log.
