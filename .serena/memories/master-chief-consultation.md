# Questions to the Master Chief

`server/peer-roster.ts` owns `canConsultMaster`: current visible assigned Chief, different visible sender, explicit peer allow-list and same audience. It does not widen `canReachPeer` or `canAccessTeam`; management and legacy message callers retain their previous policy.

`server/index.ts` uses the consultation exception only in active coordination discovery and `coordinate-bots` name resolution/validation. `roomHandoffProblem` permits a direct handoff to a consultable Master, preserving source-room section and reader-audience checks. The same validator runs at enqueue, dispatch, start, return and retained report replay.

Room requests default to a direct handoff only for a sole consultable Master outside the source room and no explicit group_id. Ordinary room defaults and explicit destinations remain unchanged. Existing durable RoomHandoffs keeps exact source thread correlation, automatic resume, loops, budgets, approvals and recipient execution settings.

`server/drivers/agents-call.ts` labels the Master in list_bots. `server/master-chief-consultation.test.ts` covers policy; `.e2e.test.ts` uses isolated scripted real-MCP fixtures for St. Paul questioning Dr. EggBot, room return, thread pinning, revocation, approvals, privacy and unchanged management. Recipe: `docs/verification/room-coordination.md`.

`bot_folders` is a read-only Master tool in `agents-catalog.ts` / `agents-call.ts`. Its wire payload uses `targetBotId`; `botId` in internal bodies is reserved for sender identity. `routes/fleet-internal.ts` validates current assignment, target visibility/audience and guest restrictions, then returns configured workspace/project/task locations. It uses `canReachPeer` for cross-team Master targets, preserving existing privacy.

`index.ts` passes `cloudGuestDriven(threadId) || cloudGuestDrivenHandoff(roomHandoffId)` for caller confinement and a `canReadThread` predicate for task filtering. Known guest-private task folders and overlapping configured folders are omitted. The read-only discovery neither changes native permission modes nor adds a filesystem/symlink sandbox. Native Full tools can operate on OS-accessible sibling folders; ACP client file confinement remains unchanged. `routes/fleet-internal.test.ts` and injected-MCP cases in consultation e2e cover this tool. Catalog goldens and read-only annotations must move with intentional tool changes.
