# Browser preview polling

`startScreenPoller` in `server/index.ts` owns per-turn screen pollers. `createScreenFrameSource` calls its `watching(surface)` callback before every non-fresh capture, after any in-flight capture finishes. `capture(true)` for the final conversation screenshot bypasses it.

After the upstream sync, the host exposes a `LiveRouter`. Its `watching(session)` checks `BrowserLive` for the agent-browser and stealth engine, plus Chrome `LiveV1` and `StreamV2` viewers. Each registry checks current authorization. The poller gates browser captures only; computer previews are unchanged.

A browser capture succeeds only after the turn claimed `browser:<session>` through a browser tool call and a screen tool event touched the turn. The fake CLI does not execute MCP tools; `scripts/verify-browser-preview-watchers.ts` spawns the turn's browser MCP server from the fixture dump.

Focused checks: `pnpm exec vitest run server/screen-frame-source.test.ts server/browser-live.test.ts server/browser/engines.test.ts`. The native fixture recipe is in docs/verification/browser-live.md under Unwatched turn previews. Node >= 24.
