# Bot-scoped panels evidence

- Coordinator thread: mcp:5fd1e62a-de3b-4649-abc3-7d2be82c8b45.
- Checkout: /home/clauber/.t3/worktrees/openmausbot/fix-bot-scoped-panels.
- Branch: fix/bot-scoped-panels. Base: ffe456fd2b52b4f23e350f3f8984057a620d50e4.
- Descendant: /root/comment_review, completed read-only comment review. One writer, coordinator.
- Old recurring backstop scheduled-task:be8bc112-2419-4715-a4c6-7ee5cc25d3e9 deleted.
- One-shot status backstop: scheduled-task:82716ed4-f03a-4288-9264-0be3f10f045a,
  due 2026-10-27T00:03:03.152Z, bound to coordinator thread.
  Sends results/status to existing Anvil thread once, deletes itself, then settles.
  Scheduler exposes intervals, so its explicit first-run deletion provides one-shot behavior.
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
- Final implementation source reviewed and independently tested: eb1291c46b1ab3fa0dc77a50da524b227e1047f9.
- Documentation follow-up head and final remote parity are recorded in /tmp/bot-scoped-panels-result.json.
- PR: https://github.com/gsdtechsolutions/Legion/pull/18. Logs are listed below.

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
- Anvil independently verified PR metadata and the exact 8-file command at implementation source eb1291c46
  using Node 24.21.0: 387 passed. Evidence /tmp/anvil-bot-panels-validation.log.
- Browser acceptance and screenshots remain assigned to Anvil. Its browser open failed:
  "another thread is using this browser — pause browser work until that thread finishes".
  Anvil reported select_computer confirmed only built-in browser ready; no alternative available.
  This is a reported browser blocker, not browser acceptance.
- No merge, deploy or restart occurred in this phase. Deployment remains under Anvil standing authority;
  it is excluded from this coordinator phase. GitHub CI also remains blocked by account billing/spending limit.
- No descendant remains running. The completed comment reviewer made no edits.

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
- Exact base/head, PR receipt and final remote parity: /tmp/bot-scoped-panels-result.json.

- Exact lint command: pnpm exec oxlint --deny-warnings src/state/store.tsx src/state/store.test.ts src/state/bot-panels.ts src/state/bot-panels.test.ts src/state/bot-scoped-panels.test.ts src/components/TaskPicker.tsx src/components/TaskPicker.visibility.test.ts src/components/TaskPicker.test.ts src/components/BotSettingsDialog.simple.test.ts src/lib/last-bot-section.ts.
- Both pnpm typecheck runs exited 0. Final tree check after edits passed. Log /tmp/bot-scoped-panels-typecheck.log.

## Startup and review activity references

Coordinator activity is the JSONL path above. Line references are 1-based JSONL records.
Start-task read is at line 20; Ponytail read at 27. Bootstrap and initial_instructions
are at 36; absolute activation at 43; list_memories and browser-preview-polling read at 51.
Serena session f4fb306d remains the prior startup evidence. This bounded follow-up
re-read start-task and the installed bug-fix playbook before documentation correction.
Bug-fix steps are inspect/reproduce stale ledger claims, trace source activity, correct
docs, verify parity, publish, send results and settle. Runtime reproduction and tests
are skipped for this docs-only follow-up because implementation is unchanged.

Thermo review was coordinator self-review, not the descendant's review. Activity
references in the coordinator JSONL: line 159 reads the installed thermo skill;
361 fixes/tests nested navigation; 411 inspects the final bot-panels module;
512 records findings and dispositions in this ledger. Final implementation source is
eb1291c46b1ab3fa0dc77a50da524b227e1047f9. No implementation edits follow it.

Comment reviewer scope was added/changed code comments and lint/type suppressions
only, over ffe456fd2b52b4f23e350f3f8984057a620d50e4..eb1291c46b1ab3fa0dc77a50da524b227e1047f9.
It was not a functional or architectural review. Counts: zero added/changed code
comments, zero added suppressions, zero edits, zero findings.
Reviewer activity: /home/clauber/.codex/sessions/2026/10/26/rollout-2026-10-26T19-40-42-01a17a96-71ee-7112-b872-647ae5d4b83d.jsonl.
Native descendant ID /root/comment_review, session 01a17a96-71ee-7112-b872-647ae5d4b83d.
Reviewer startup: catalog discovery line 30 preceded start-task read line 35, a
first-tool ordering deviation. Bootstrap and initial_instructions at 44; absolute
activation at 52; list_memories and bot-scoped-panels read at 58, session ddad3c24.
Ponytail and framework docs were inherited from the full-history parent; no new
implementation or API work occurred. Do not interpret this as fresh first-tool compliance.

## Source remote parity

Fetched fork/fix/bot-scoped-panels and compared git object IDs for all 13 changed
paths plus existing .serena/project.yml at implementation source eb1291c46.
All 14 local/remote blobs matched. Config was already tracked and is unchanged.
Command pattern: git rev-parse eb1291c46:<path>; git rev-parse fork/fix/bot-scoped-panels:<path>.
Machine evidence: /tmp/bot-scoped-panels-source-parity.json.
Thermo activity extract: /tmp/bot-scoped-panels-thermo-activity.json. Final docs follow-up
parity will be checked again after push and recorded in /tmp/bot-scoped-panels-result.json.

| Path | Matching local/remote blob at source head |
| --- | --- |
| .agents/bot-scoped-panels-evidence.md | 62eb7514e3e8e8deb9ed9879929a7f63204e4144 |
| .agents/bot-scoped-panels.spec.md | 0d1a5f6ef93cfcc1c053f0ee29e9f6f76353ccd6 |
| .serena/memories/bot-scoped-panels.md | e0c75620d36f326ffd69c7635084e27a90963667 |
| src/components/BotSettingsDialog.simple.test.ts | 98b488c2820c3422ce70f7e2dd85e68202d25c6f |
| src/components/TaskPicker.test.ts | 1c02e885a8b718cc2ff04815fd1c3b9ddf5f6102 |
| src/components/TaskPicker.tsx | 0394884efb6dd66209130b933ceccb0e066b7635 |
| src/components/TaskPicker.visibility.test.ts | a2ed043131e7b36062d4be6770e9838a89a37211 |
| src/lib/last-bot-section.ts | 99e99dd098cbbe64d5a45dde5c431da4d973c832 |
| src/state/bot-panels.test.ts | 36a1c9b5ca348094fcfa7b2e85c1024df55afac1 |
| src/state/bot-panels.ts | 97303e58619b23ea9c65eafd677fc1a14698e197 |
| src/state/bot-scoped-panels.test.ts | 09e7f55b5797957777e630f24775f52e82feec0a |
| src/state/store.test.ts | 6e936f10b34a681b0317933c5c0ab91533757d73 |
| src/state/store.tsx | 58822e99d15307d262a64ad546c9d3376e311c04 |
| .serena/project.yml | 2a6899e2df78976000fcf4780dbd3749c048b551 |

## Real browser header failure and correction

Anvil failed original acceptance at c56df2b7f13e2e23a95640a9c9e3c3ce023145ca: Alpha open, actual header All threads showed Beta and Fixture Starter. Screenshot /home/clauber/.openmausbot/stealth-browser/screenshots/profile-d86d5b3f409549ac9b3b3eaa6c8f034d/screenshot-1793076539836.png. Earlier387 tests cover insufficient path and do not prove this dropdown. TaskPicker is separate; actual ChatView uses AllThreadsButton. Sol delegate startup/identity/red/green receipts /tmp/pr18-header-implementation.json. Source preview provenance /tmp/pr18-header-preview-identity.log verified actual original Vite source and c56 unscoped header; final served scoped module /tmp/pr18-header-served-fix.log.

Regression-only commit5097bba8f preserves three failing real-menu regressions before fix; exact red patch /tmp/pr18-header-red.patch, log /tmp/pr18-header-red.log. Focused43 pass /tmp/pr18-header-scope-green.log; typecheck explicitexit0 /tmp/pr18-header-typecheck.exit; changedfilelint0 /tmp/pr18-header-lint.exit. Broader focused ChatViewcontrols3 failures identical unchanged-source baseline /tmp/pr18-header-baseline.log; not claimed green. No global helper/fixture hiding changes. Independent review and coordinator gate in progress. Anvil owns browser reacceptance.

Correction artifact: regression5097bba8f, implementation dff4b58c585c67a248999d324c0220025a600cbb. Source tree9494465e636142b6029a6e6b4c325d986dcbeec1. Coordinator exact43test rerun exit0 /tmp/pr18-header-coordinator-green.log. Independent native /root/pr18_header_independent_review PASS for source/thermo only, report /tmp/pr18-header-independent-review.md; no browser claim. Full3file correction diff againstc56 SHA4783df0332d6459237a831c1b2d45aa6d0f0a97becde8f1cccadadc058d2ace1, blobs /tmp/pr18-header-source-parity.json. Staged and outgoing attribution and gitleaks passed for both source commits. Preview5174 serves scoped Vite source, no preview/production restart. Publication pending required hooks /tmp/pr18-header-push.log.
