# Grok Bot import

Run the isolated server fixture and importer regressions with Node 24:

```sh
pnpm exec vitest run server/grok-import.e2e.test.ts server/cursor-session.test.ts server/team-library.test.ts shared/grok-import.test.ts src/lib/team-import.test.ts src/components/GrokImportBox.test.ts src/components/GrokFinishSetup.test.ts
node --test electron/package-link.node-test.mjs
```

The end-to-end test launches `launchVerificationServer` with its disposable
home, data directory and fake engine. It checks URL rejection, optional Cursor
sign-in and sign-out routes, then imports a synthetic export through the real
team API. The resulting bot has its instructions in `bots.json`, its skill
disabled, its routine paused, and its starter memory in a subsequent export.

Public-page and Cursor fixtures stub the external HTTP boundary. They check
marketplace-to-share resolution, bounded downloads, token scope, refresh,
revocation, refusal redaction and fallback messages. They do not prove that a
real authenticated Cursor account can currently download a template.

For UI acceptance, launch the standard disposable fixture and open Templates
→ Import. Load a marketplace URL, inspect the public card, and use Start from
description to preview and add an approximate bot. Separately paste a
synthetic JSON export and verify the preview names disabled skills, paused
routines and any omitted capabilities. Never use live workspace data.

## Staging acceptance, 2026-10-21

The production renderer was exercised against a `control-omb` fixture with
its own home and data. The Dr Eggbot marketplace URL resolved to the public
card, and **Start from description → Add team** created a bot whose saved
instructions include the public description. A separate synthetic export
was pasted and added through the UI; API read-back confirmed its exact
instructions, disabled `egg-review` skill and paused `Morning review` routine.

The final focused run passed 112 tests in eight files. Renderer/server
TypeScript checks, the renderer build and bundled server build passed.
Independent review found no blockers. The real authenticated Cursor download
was not exercised.

The deployed staging image is `legion-stg:marketplace-20261021`, image ID
`sha256:73f6608850f5a0dd242a2aad3d9ce5e0547e8b830f04d4f487e3a6a882ce58d6`.
Public `/api/health` and `/` returned 200; unpaired `/api/bots` returned 403.
The deployed importer resolved Dr Eggbot successfully while signed out of
Cursor. The staging preview was paired; its automation host disconnected
before the post-pairing UI walkthrough completed. The complete import UI
walkthrough above used the isolated local fixture.
