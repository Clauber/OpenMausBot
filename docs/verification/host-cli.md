# Universal host CLI

Extend `vm_exec` with an explicit host target. Preserve the default Local VM target.
Use a turn-scoped agents capability, the bot and thread task workspace, and `sh -lc`.
Return stdout, stderr, exit code, timeout and truncation. Cap captured output at 64 KiB.
Default timeout is 60 seconds, maximum 300. Kill descendants on timeout or revocation.

Apply managed host policy, tool scope, bot and conversation approval mode, approval rules,
auto review, saved exact commands, alwaysAllow, and the existing safety floor.
Recheck permission after approval. Off and expired turn capabilities cannot execute.
Browser-only selection does not disable CLI. Guest-confined turns retain their existing shell prohibition. API-only drivers use the existing agents mount.

Keep Auto, Browser and Off as primary Works on tiles. Collapse explicit desktop choices
under Advanced. Keep existing host availability checks, stored values and locale keys.

Do not migrate data, alter stealth-browser or autonomy, switch VM commands to host,
or verify against live data. Focus checks on changed contracts and isolated fixtures.

## Focused verification

Run with Node 24 from an isolated checkout:

```sh
npm run typecheck
npx vitest run server/host-exec.test.ts server/surface.test.ts server/drivers/agents-call.test.ts
npx vitest run server/drivers/agents-catalog-wire.test.ts -t 'offers the explicit host CLI'
npx vitest run server/agents-bridge.e2e.test.ts -t 'runs Browser bot host CLI'
```

The end-to-end test launches its own verification server and fake Claude driver.
It checks the mounted agents configuration and invokes the real host route, answers an Ask approval, checks
its workspace and shell output, then refuses a request after Works on becomes Off.
The helper tests run real shell commands in temporary folders and prove output
limits, nonzero exits and timeout termination. No test uses a live app or bot data.
