# Browser preview polling

`startScreenPoller` in `server/index.ts` owns per-turn screen pollers (6 s tick, plus tool-event pokes). `createScreenFrameSource` (`server/screen-frame-source.ts`) calls its `watching(surface)` callback before every non-fresh capture, after any in-flight capture finishes. `capture(true)` (final conversation screenshot, `finalScreenFrame`) bypasses it.

Legion has one viewer registry: `BrowserLive.watching(session)` in `server/browser-live.ts` (the stealth engine attaches through agent-browser, same viewers). The poller gates the browser surface only; computer previews are unchanged.

A browser capture succeeds only after the turn claimed `browser:<session>` (a real browser tool call) and the turn is `touched` by a screen tool event. Legion's fake CLI does not execute MCP tools; `scripts/verify-browser-preview-watchers.ts` spawns the turn's browser MCP server from the fixture dump to do it.

Checks: `pnpm exec vitest run server/screen-frame-source.test.ts server/browser-live.test.ts`; native proof in docs/verification/browser-live.md "Unwatched turn previews". Node >= 24.
