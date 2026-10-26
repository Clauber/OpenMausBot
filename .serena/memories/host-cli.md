# Host CLI

- `vm_exec` in `server/drivers/agents-catalog.ts` retains the Local VM default and adds explicit `target: "host"` when `OMB_HOST_CLI=1`.
- Host dispatch uses `/api/internal/host-exec` in `server/index.ts`, `ensureTaskWorkspace`, and bounded `server/host-exec.ts` execution.
- Authorize and revoke against current `store.projectBotForTask` records. `botForThread` can return the turn-start snapshot and must not enforce live Off or permission changes.
- Host execution honors managed host policy, tool scope, task approval mode, grants, approval rules and safety floor. Guest threads and guest handoffs retain their shell confinement.
- Focused commands and limits live in `docs/verification/host-cli.md`. The picker in `ComputerPanel.tsx` shares primary and collapsed Advanced tiles across interface modes; old locale keys remain unchanged.

- New agents capability flags must be included in `server/drivers/agents-mcp-env.ts` so HTTP mounts preserve them. `server/routes/own-mcp-http.test.ts` checks the engine encoder and HTTP catalog roundtrip with host CLI enabled and disabled.
