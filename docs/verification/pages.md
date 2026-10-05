# Pages workspace verification

Use Node 24 or later and an isolated fixture. Never target live workspace data.
The driver uses `launchVerificationServer` from `control-omb`, which owns a
throwaway home, data directory, free port pair and repository fake engine.

```sh
pnpm typecheck
pnpm exec vitest run server/pages-db.test.ts server/routes/pages.test.ts \
  server/drivers/agents-catalog-wire.test.ts shared/live-approval.test.ts \
  server/system-prompt.test.ts
pnpm exec vite build
node --experimental-strip-types scripts/verify-pages.ts --ui
```

The HTTP test and standalone driver exercise the real route table, auth gate,
agents stdio MCP proxy, existing approval response API and fake engine. Evidence
includes request method, path, JSON body, status and response. Credentials and
launch environment dumps are excluded. Oversized validation inputs are bounded
in the saved evidence.

The driver proves:

- Cross-origin, invalid-session and limited-client refusal; proposal capabilities
  cannot impersonate a different thread; limited clients cannot approve pages.
- Create, read, nest, cycle rejection, revision update, HTTP 409 with
  `stale_revision`, search, title/content limits, missing revisions and deletion.
- Save the active transcript as Markdown with a `sourceThreadId` backlink.
- Advertise and call `propose_page` through the agents MCP process. A retry keeps
  the original review copy and request id. The existing card's respond route,
  called twice, returns one page id; the list contains one matching document.
- Create a page-chat thread, send through control-omb, and inspect the fake
  engine's actual system prompt/context for the page marker and revision.

`--ui` serves the production `dist/` bundle in a Vite preview proxied only to that fixture. Build it first; no development transforms are used.
It uses the repository's pinned agent-browser/Chrome, opens the Pages workspace,
checks the sidebar entry and Markdown preview, edits and verifies autosave,
introduces a concurrent server edit, checks HTTP 409 draft retention, reloads,
overwrites explicitly, opens page chat, follows the source backlink, approves a new page through the existing composer, and creates a nested page in the UI.
Screenshots capture the conflict and the final workspace. The browser stays
parked on the validated page; the disposable API and Vite fixtures stop after
validation. That tab's rendered state remains visible; reload requires a new
fixture.

The command prints `evidencePath`, `logPath`, screenshot paths and browser session.
The JSON, `.ui.json`, `.conflict.png`, and `.workspace.png` sit beside the retained
server log under `/tmp/openmausbot-verification-evidence/`. The driver stops its
exact child and removes temporary data in `finally`, including failed checks.
Use `--preview` to keep a manual fixture running until Ctrl-C; it prints the
explicit API and preview URLs. `--ui --preview` validates and then parks it.

The storage test separately reopens SQLite to prove receipt persistence, denies
an approved-then-denied reversal, checks FTS maintenance and cross-space parents.
Run the targeted tests only; the full engine-install/registry suite is outside
this ticket's gate.
