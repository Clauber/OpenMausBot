# Master Chief authority on the LEGION line

Owner selects a singleton through server/routes/fleet.ts. Assignment and revision live in config; generic config patches cannot write them. No assignment is created on load.

server/fleet-authority.ts supplies isMasterChief. Team and peer bypasses retain hidden-bot and audience boundaries. Existing owner-authorized mixed rooms keep their separate behavior; master room-task grants are persisted and checked by server/fleet-rooms.ts against issuer audience, assignment revision and exact membership. Transcript feeding remains unchanged.

server/master-permissions.ts invokes the existing trusted permission phases. A master cannot edit its own execution permissions. Deletion remains owner-confirmed. server/fleet-audit.ts durably records changes and revocations. Turn entry points use withoutFleetActor so recipients execute as themselves.

Verify with the four fleet/master unit suites and server/master-chief.e2e.test.ts, plus affected peer/team/room tests. Always use disposable data (docs/verification/README.md). This LEGION line retains native ZCode and importer modules; do not replace it with upstream's newer package just to obtain this feature.
