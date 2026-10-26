# Bot-scoped chat panels

Chat header TaskPicker supplies only [bot] to crossBotAttentionThreads. Sidebar global activity intentionally retains cross-bot helpers. Do not change those helpers to filter globally.

src/state/bot-panels.ts owns bot details panel snapshots and storage key openmausbot.botPanels.v1. Store reducer reconciles panel state atomically across selection, hydrate, added/deleted bots and explicit settings targets. StoreProvider loads before hydration and writes after hydration. Legacy openmausbot.lastBotSection.v1 is ignored. Screen/computer state uses its existing paths.

Focused checks: pnpm exec vitest run src/state/bot-scoped-panels.test.ts src/state/bot-panels.test.ts src/state/store.test.ts src/components/TaskPicker.visibility.test.ts src/components/TaskPicker.test.ts src/components/SidebarBotActivity.test.ts src/components/BotSettingsDialog.simple.test.ts src/lib/last-bot-section.test.ts. Use Node >=24. Always isolate fixture per docs/verification/README.md.