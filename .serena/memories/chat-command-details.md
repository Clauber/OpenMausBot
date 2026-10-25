# Chat and Activity tool details

- `server/activity.ts` joins stored redacted `WireMessage.tool` records through `messagesFor(threadId)`, matching thread, turn and item. Ambiguous legacy turnless matches omit details.
- `shared/activity.ts` declares `ActivityRow.detail`; the route wiring lives in `server/index.ts`.
- `ToolDetailBody` in `src/components/ToolActivity.tsx` is shared by inline chat and `ActivityPanel.tsx`. Preserve thought/place rendering and stored preview redaction.
- ActivityPanel uses the shared live-events bus and stable serialized thread IDs so task-array rerenders cannot cancel pending refreshes.
- `showToolCalls` defaults true; explicit false remains honored.
- Verification uses the isolated `scripts/verify-chat-polish.ts` fixture, documented in `docs/verification/chat-polish.md`. Tests include `server/activity.test.ts`, `server/config.test.ts`, and `src/components/live-panels.test.ts`.
