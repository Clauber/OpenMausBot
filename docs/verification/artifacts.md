# Verifying artifacts

```sh
node --experimental-strip-types scripts/verify-artifacts.ts
pnpm vitest run server/artifacts.e2e.test.ts server/web-tools.test.ts
```

A real harness with the fake engine. The script writes two files into the bot's workspace (standing in for the engine), attaches them through `/api/internal/attach-file` with the bot's turn capability, and rewrites one before attaching it again.

- Two artifacts in `GET /api/threads/:id/artifacts`; the rewritten file is v2, the other v1.
- `/api/artifacts/:id/versions` lists v1 and v2; downloading each returns that version's own bytes.
- A second bot's thread lists none; unknown thread and artifact ids are 404.

UI: select a bot that has attached files, open Inspector → Run log, and check the "Files from this conversation" list, the version dropdown on a rewritten file, and the download link.
