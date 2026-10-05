# Taught skills verification

Run from an isolated feature worktree with Node 24 and installed dependencies:

```sh
node --experimental-strip-types scripts/verify-taught-skills.ts --ui
pnpm exec vitest run server/teaching-session.test.ts server/teach-capture-client.test.ts server/taught-skills.e2e.test.ts server/mcp-bridge.test.ts server/browser-runtime.test.ts server/skill-library.test.ts server/skills-library-api.test.ts server/container-mcp.test.ts server/local-computer-proxy.test.ts server/skills.test.ts src/components/ComputerPanel.test.ts src/components/SkillsSection.test.ts src/components/SkillsSection.behavior.test.ts
pnpm exec vitest run server/index.test.ts -t 'only enables the exact learned-skill'
pnpm typecheck
```

The script launches `control-omb`'s disposable fake-engine server with an
explicit repository fake MCP computer. The launch validates a loopback MCP
URL and passes it only into that child. Native tool schemas use the repository's
provider-safe schema helper; fake tool calls never drive a desktop or navigate
to their example URL. This does not exercise a real VM or cloud provider.

It proves the mandatory gates through the real server routes and skill lifecycle:

1. Record navigate, click, type: persist three ordered events, screenshot refs,
   `playbook.json` and the `SKILL.md` summary in the library.
2. Request first replay: no dispatch before the standard approval card; refuse
   a missing reviewed hash; approve through `/api/threads/:id/respond`; execute
   the three native MCP calls in order and persist successful history.
3. Make the fake click return element-not-found: fail at index 1, with no type
   call or further steps.
4. Replay the lifecycle-approved skill: succeed without another approval card.

Additional assertions cover always-ask/denial, per-bot approval, rejected shell
tools, screenshot mismatch, manifest integrity, interrupted-run recovery and
the optional rules hook. The bridge integration test records actual stdio
driver calls through the existing control gate and waits for capture before
returning the tool result, so Stop cannot race completed driver calls.

With `--ui`, the script mounts the real Computer panel, Skills section and
ChatView through the repository preview helper against that isolated server.
It records three steps with the controls, saves, replays, answers the real
approval card, checks success and failed-step history, changes the always-ask
switch and discards another recording. Screenshots and the request/MCP trace
are kept in `.omb-scratch/verify-evidence/taught-skills/`:
`recording.png`, `approval.png`, `failed-run.png`, `playbooks.png`, `evidence.json`.
The script prints its owned fixture URL, PID, temporary data path and retained
server log. It closes the preview, server and fake MCP computer in `finally`.
The `teach11` browser tab stays parked on the validated fixture page; its
backend is intentionally stopped after the evidence is saved.

The Electron bridge regression needs Linux GUI libraries even when running
as Node. On a minimal headless host, provide them via a worktree-local
`LD_LIBRARY_PATH`; do not skip that test or substitute the user's live app.
