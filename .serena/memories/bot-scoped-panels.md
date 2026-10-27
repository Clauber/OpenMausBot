# Bot-scoped chat panels

ChatView mounts AllThreadsButton from src/components/ChatAllThreads.tsx for its All threads header dropdown. That component scopes crossBotAllThreads input to bots whose id equals state.selectedId and passes no groups. TaskPicker is a separate path, already supplying only [bot] to crossBotAttentionThreads. Sidebar global activity intentionally retains cross-bot helpers. Do not filter those helpers globally.

src/state/bot-panels.ts owns bot details panel snapshots and storage key openmausbot.botPanels.v1. Store reducer reconciles panel state atomically across selection, hydrate, added/deleted bots and explicit settings targets. StoreProvider loads before hydration and writes after hydration. Legacy openmausbot.lastBotSection.v1 is ignored. Screen/computer state uses its existing paths.

Header regression: src/components/ChatAllThreads.test.ts mounts the real dropdown in happy-dom, opens it, checks current-bot history and activity, excludes other bots/groups, switches bots while open, checks missing selection, and dispatches the exact sibling thread. Focused command: pnpm exec vitest run src/components/ChatAllThreads.test.ts src/components/SidebarBotActivity.test.ts src/components/TaskPicker.visibility.test.ts. Browser acceptance remains separate and required.

Panel checks: pnpm exec vitest run src/state/bot-scoped-panels.test.ts src/state/bot-panels.test.ts src/state/store.test.ts src/components/TaskPicker.visibility.test.ts src/components/TaskPicker.test.ts src/components/SidebarBotActivity.test.ts src/components/BotSettingsDialog.simple.test.ts src/lib/last-bot-section.test.ts. Use Node >=24. Always isolate fixtures per docs/verification/README.md.
