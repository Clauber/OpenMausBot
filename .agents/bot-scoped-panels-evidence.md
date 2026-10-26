# Bot-scoped panels evidence

- Coordinator thread: mcp:5fd1e62a-de3b-4649-abc3-7d2be82c8b45.
- Checkout: /home/clauber/.t3/worktrees/openmausbot/fix-bot-scoped-panels.
- Branch: fix/bot-scoped-panels. Base: ffe456fd2b52b4f23e350f3f8984057a620d50e4.
- Descendants: none. One writer, coordinator.
- Backstop: scheduled-task:be8bc112-2419-4715-a4c6-7ee5cc25d3e9, 15 minutes.
- Result callback: scheduled-task:bfe0c272-2e92-475e-b6f3-ce9645cb5a44.
- Completion target: Anvil bot a1ddaf91-0730-44ac-8c17-a0264d3d352d,
  existing LEGION thread a1d02757-cb75-4140-a814-f2e0380340d4.
- Runtime browser preview_status returned available:false.
- Serena session f4fb306d, absolute checkout activated, browser-preview-polling memory read.
- Lockfile React 19.2.8, Vite 7.3.6, Vitest 4.1.11, TypeScript 5.9.3/6.0.3.
- Context7 React 19.2.8 query returned compiler fixtures, insufficient persistence
  coverage. Existing reducer architecture owns state; no new React API needed.
- Principles: fix-root-causes scopes input and state ownership; guard-context-window
  bounds reads; prove-it-works requires real fixture evidence; type-system-discipline
  validates persisted values at storage boundary.
- Startup shell Node 22.23.2 is below project requirement. Cached Node 24 available.
- Logs and final head: pending.

## Checks and review

- Regression commit e18af3694c21c94881590ceb84f3857924b51284.
- Red command: pnpm exec vitest run src/state/bot-scoped-panels.test.ts src/components/TaskPicker.visibility.test.ts.
  Exit 1, 3 failures. Log /tmp/bot-scoped-panels-red.log.
- Focused final command: pnpm exec vitest run src/state/bot-scoped-panels.test.ts src/state/bot-panels.test.ts src/components/TaskPicker.visibility.test.ts src/state/store.test.ts src/lib/last-bot-section.test.ts src/components/SidebarBotActivity.test.ts src/components/TaskPicker.test.ts src/components/BotSettingsDialog.simple.test.ts.
  Exit 0, 8 files, 387 tests. Log /tmp/bot-scoped-panels-green.log.
- Changed-file lint: pnpm exec oxlint --deny-warnings on changed TS/TSX files. Exit 0. Log /tmp/bot-scoped-panels-lint.log.
- Node 24.21.0 from cached pnpm node/bin is first in PATH for install/checks.
- Isolated preview HTTP 200: http://127.0.0.1:5174/__threads.html.
- Fixture API http://127.0.0.1:21890, data /tmp/openmausbot-verify-data-W4GaqV.
- Fixture PID 3459559, launcher PID 3459457, exec session 43255.
- Server log /tmp/openmausbot-verification-evidence/server-1793057578418-3459457.log.
- Preview receipt /tmp/bot-scoped-panels-preview.json, launcher log /tmp/bot-scoped-panels-preview.log.
- Browser tools: preview_status available:false, no browser/playwright tools exposed.
  Screenshot evidence and browser acceptance remain pending Anvil's existing Browser tab.
- Thermo-nuclear review by coordinator: panel transitions centralize in an 84-line module,
  instead of scattering persistence across selection paths. No file crosses 1000 lines.
  Store was already above 1000 lines. Nested reducer state must use next.botPanels; fixed
  and tested via openDataResult. Explicit target reopening must retain expansion; fixed
  and tested. Unchanged snapshots retain map identity, avoiding storage writes per token.
- Two affected UI test fixtures were stale: title search expected Legion but queried
  openmaus; window stub lacked location.hash. Fixed fixtures only, no runtime workaround.
- Global activity helper tests pass unchanged. No browser/Screen implementation changed.
- Independent validation, screenshots and merge remain open. No deployment authorized.
- Descendants remain none.

- Fixture seed: Alpha and Beta each completed a fake-engine turn and both reported
  busy:false, unread:true. Alpha received a second thread via HTTP 201.
  This gives Anvil cross-bot unread activity and same-bot thread switching to inspect.
- Preview workflow: open Alpha header dropdown, confirm Beta absent; global sidebar
  activity still includes Beta. Open Alpha Soul; switch Beta, initially closed;
  open Beta Identity and close it; return Alpha, Soul remains expanded. Switch
  Alpha threads, then reload. Repeat with collapsed accordion. Capture screenshots
  and console results. Browser/Screen choices remain on existing code paths.
- Secret scan: gitleaks dir --redact --no-banner /tmp/bot-scoped-panels-staged.patch.
  Exit 0, no leaks. Log /tmp/bot-scoped-panels-secrets.log.

- Coordinator activity log: /home/clauber/.codex/sessions/2026/10/26/rollout-2026-10-26T19-26-19-01a17a89-46ad-7e10-8caa-df23eb8f8b06.jsonl.
- Final exact base/head and PR receipt will be written to /tmp/bot-scoped-panels-result.json after commit.

- Exact lint command: pnpm exec oxlint --deny-warnings src/state/store.tsx src/state/store.test.ts src/state/bot-panels.ts src/state/bot-panels.test.ts src/state/bot-scoped-panels.test.ts src/components/TaskPicker.tsx src/components/TaskPicker.visibility.test.ts src/components/TaskPicker.test.ts src/components/BotSettingsDialog.simple.test.ts src/lib/last-bot-section.ts.
- Both pnpm typecheck runs exited 0. Final tree check after edits passed. Log /tmp/bot-scoped-panels-typecheck.log.
