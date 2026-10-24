# Master Chief of Staff

Status: Dr Eggbot's design-review conditions incorporated; pending owner review.
No implementation or live promotion.

## Outcome and agreed scope

Clauber wants one Master Chief of Staff with autonomous management authority
over every LEGION bot, including General/sectionless bots and other Chiefs.
Clauber selected Dr Eggbot, bot ID `a7c4c0a8-b83d-4fcc-9bcd-a8b6269bf2de`.
The role can deliberately change another bot's `approvalMode`, including Full
Access. Deletion requires separate confirmation. All applied changes are audited.

This design covers all bots in the LEGION instance's authoritative bot store.
It does not introduce a remote-installation registry or cross-server protocol.

## Current evidence

- `server/chief-of-staff.ts`, `chiefOfStaffSystemPrompt`, derives its roster
  through `reachablePeers`, describes section and managed-section authority,
  and keeps other bots' execution permissions separate from setup changes.
- `docs/verification/team-setup.md` describes scoped setup, editable
  `chiefOfStaff`, owner review, durable receipts, and atomic bot persistence.
- `docs/verification/full-access.md` documents immediate changes under Full
  Access, including deletion, and refusal of out-of-scope targets. The new
  master deletion contract must override that immediate-deletion behavior.
- Dr Eggbot reported a profile refusal and a room coordination refusal for
  sectionless Pam Beesley (`6271a8e5-4dfa-454d-b05b-d089bc1b555a`). These are
  supplied production observations, not reproduced in this design phase.
- Read-only observation on 2026-10-22: all 24 bots in
  `/home/clauber/.openmausbot/bots.json` have absent/null visibility.
  `storedVisibility` in `server/bot-visibility.ts` maps both to `everyone`,
  so no current fleet pair is audience-blocked. This is a dated observation,
  not an invariant: setting `admins` or a people list can change it.
  Michael Scott is both sectionless and a Chief, a useful combined fixture shape.

## Authority and persistence

Persist one nullable `masterChiefOfStaffBotId` in instance configuration.
Derive the bot-facing master flag from this single assignment; do not persist
independent flags on multiple bot records. Zero holders is valid before
assignment or after owner revocation; two holders is never valid.

Only authenticated owner controls can assign, replace, or revoke this setting.
The master cannot grant or transfer master authority through profile, team,
import, or bot-edit tools. Replacement validates an existing Chief and changes
the single assignment atomically. The initial assignment is an explicit owner
action selecting Dr Eggbot; no name matching or hardcoded production ID migration.

The holder must remain a Chief. Reject demotion or deletion of the current
holder until the owner transfers or revokes the assignment. Other Chiefs'
`chiefOfStaff` fields remain editable under normal leadership consistency rules.
Existing installations default to no master and retain their scoped behavior.
Owner-only assignment does not remove existing admin permission-setting rights.

## Authorization and visibility

Introduce one fleet-authority predicate derived from the current store and
authenticated active-turn identity. Thread it through `chiefPeerTargetRule`
in `server/index.ts`, `canReachPeer` and `canAccessTeam` in
`server/peer-roster.ts`, and the `coordinatorSupervises`, `outsideSection`,
`roomHandoffProblem` and `roomTalks` checks in `server/host/room-access.ts`.
Never trust a caller-supplied
actor ID or a prompt claiming master status. Check current authority at tool
execution and again before deferred mutations commit, so transfers revoke old
authority without requiring a provider restart.

Fleet authority bypasses section and managed-section restrictions for bot
discovery, target lookup, configuration, direct bot messaging, coordination,
and room creation/membership. It bypasses the initiating master's `peers`
allowlist without rewriting that list or another bot's list. `peerAllowed`
also enforces `sameAudience`; that distinct audience/privacy invariant remains
in force. Report an audience refusal accurately rather than calling it a
missing section grant. Management authority does not expand transcript audiences.

Sections absent, null, empty, or not registered as a team are all in scope.
Preserve existing hidden/deleted target lifecycle guards: hidden bots cannot
receive work or be silently treated as successfully updated. Return an explicit
unavailable-target result. Master assignment must name a visible, existing Chief.

`list_bots` and `list_room_targets` expose the full eligible fleet, including
unavailable bots with their actual status, without a section filter. Injected
rosters can stay capped: `LIVE_PEER_ROSTER_MAX` is 12, and
`livePeerRosterBlock` already reports omissions and directs callers to
`list_bots`. Preserve that behavior for the master rather than requiring every
bot to appear in each prompt.

Cover `propose_profile`, `propose_team_setup`, `propose_routine*`,
`propose_bot_deletion`, `coordinate_bots`, and `send_to_bot`, including their
`for_bot_id` paths and underlying shared authorization helpers.

Outside explicitly authorized rooms, ordinary Chiefs retain existing scope.
Fleet authority does not bypass expired
turn tokens, safety rules, lifecycle guards, unrelated tool restrictions, or
provider compatibility checks. It does not grant unrestricted access to other
bots' private conversation history, credentials, or execution identities.
Refusals distinguish missing fleet/team management authority from missing
execution permission and identify the failed requirement.

## Cross-section room participation

Giving only the master a section bypass is insufficient: `outsideSection`
and `roomTalks` inspect every member from each speaker's perspective. A room
with General and Support members must support both participants, not only
the master. Master-only cross-section rooms do not satisfy this requirement.

When the master explicitly assembles cross-section work, persist a scoped
room-task communication grant naming the issuing master assignment, exact
room/task, and authorized member IDs. It permits those members to speak in
that conversation and exchange same-task handoffs. Apply it
consistently to source and destination room checks, including room-lane work.
It can bypass section and peer-list checks only inside that exact task;
audience checks, member existence, room membership, turn authenticity and
execution permissions remain enforced.

Evaluate the grant from every speaker's perspective against every other reader
in the task. A membership change not covered by a current grant fails closed
for every cross-section participant in that task, not only for the new member.
Ordinary same-section work already authorized without the grant is unaffected.

The grant does not alter `roomFeeds`, `audienceWithin` or `roomFeedsBot`.
Transcript delivery stays governed by audience containment; the grant only
permits speaking and same-task handoffs. Preserve `roomAudienceConflict` in
`server/index.ts` at room creation and membership add, including its refusal:
"Bots in one room must be visible to the same people."

Create a fresh empty room task for a new cross-section membership set; the
grant cannot expose earlier room transcripts. New members are not implicitly
authorized. Membership removal takes effect immediately. Any membership
change requires a fresh master-issued grant for further cross-section work.
Recheck its issuing assignment on each protected operation; transfer or
revocation invalidates the grant's bypass, and the new master can explicitly
authorize a fresh task. Explain that refusal rather than silently queueing work.

Room-task grants persist across reload. The `approvalGrant` revoke-on-load
behavior does not apply to them. Revocation comes from master transfer or
revocation, membership change, or explicit owner action; reload alone cannot
invalidate an otherwise current room grant.

Participants gain no right to direct-message outsiders, open other rooms,
change bots, or use another member's execution permissions. Direct master
coordination to one target must continue to work without creating a shared room.

## Applying changes and execution permissions

With a Full Access requesting turn, non-destructive management operations apply
directly and return persisted results without an additional review card.
Master authority itself does not turn an Ask thread into Full Access.

Expose `approvalMode` as an explicit field in the master's management tool
contract. Validate supported modes and provider compatibility through the same
server policy as owner settings. Reject injected execution-permission fields
from ordinary Chiefs; never silently ignore an invalid requested change.
Keep validation consistent with `PERMISSION_FIELDS` in `server/registry-save.ts`,
`BOT_FIELDS_ADMINS_SET` in `server/team-move-in.ts`, and administrative activity
field validation. Expose only the intentional master permission operation,
not an unrestricted bot-record patch.

The master cannot use its management tools to change its own `approvalMode`,
`autoApprove`, `alwaysAllow` or `peers`. Only the owner changes the master's
own permission posture. Ordinary self-profile changes follow the existing
self-profile path and cannot smuggle these fields into a SOUL/name edit.

Changing a bot's default mode affects future threads and runs. Existing thread
overrides remain intact by default. Provide an explicit `applyToAllThreads`
option for the master to deliberately update existing threads through the
existing owner permission-change path. A result reports default-only versus
all-thread scope. The tool maps `applyToAllThreads` to the existing
`allThreads` owner operation; it inherits that operation's constraints instead
of creating a less restrictive permission writer. Reject combinations with
`threadId`, `threadOnly`, `modelSelection`, `updateBotDefault` or Custom mode.
Tightening all threads to Ask stops the target's active turns; report that
effect and any stop failure. Widening to Full refuses if a grant is pending,
any thread is busy, or any relevant provider cannot support the requested mode.
Preserve other supported modes' provider checks and local-computer warnings.
Do not obtain owner-channel privileges from bot-supplied identity or headers.

A stalled approval-card thread is not promised to resume: whether it counts
as busy and what the existing grant path permits need fixture evidence.
A default-only edit never reports that an existing stalled thread was fixed.
Permission changes cannot silently retry external work.

Distinguish activated mode changes from pending `approvalGrant` transitions.
`Store` load revokes unactivated grants before work starts: thread-only grants
reset that thread, while broader grants reset the bot and elevated tasks.
Record revocation as a new audit event, linked to the originating operation;
never describe a pending grant as a completed persistent elevation.

Profile edits, model edits, coordination, room membership and role changes
never implicitly copy the master's permissions to targets. Dispatch continues
to execute as the target with its own effective permissions. Newly created
bots retain instance defaults unless permission changes are explicit.

Deletion always produces a separate confirmation for master-originated
requests, even under Full Access. It names the exact bot and uses the existing
owner-confirmation and deletion lifecycle. Neither the master nor a delegated
bot may approve that confirmation. Revalidate authority and target state when
the owner confirms; preserve busy-target and external-resource cleanup guards.

## Audit and results

Keep a durable, owner-readable record of each master mutation: operation ID,
authenticated actor bot and initiating thread, target bot, timestamp, operation,
changed fields, and before/after values. Include explicit permission changes
and owner assignment/transfer/revocation events. Reuse existing receipts where
they satisfy this contract; do not rely on provider narration as evidence.

Audit only durable changes as applied. Couple mutation and its receipt using
the store's durable transaction/receipt pattern. Preserve `keptRevocation`
semantics in `server/registry-save.ts`: a failed save rolls back a widening,
but a tightening may remain enforced in memory. In that case report the save
failure and retained runtime restriction explicitly; do not claim it is
durable. Include its recovery/reconciliation event in the next successful save.
Do not weaken enforcement merely to align runtime state with failed persistence.
Replays do not duplicate
mutations or audit records. Redact credential material. Deletion records survive
target removal. Messaging and membership records must identify participants
without copying private conversation content into the management audit.

Tool results distinguish applied, pending confirmation, rejected and failed.
Return the target and changed fields, plus the receipt identifier. Expose audit
history through an owner-readable management surface with bot/actor filtering.

## Acceptance contract

Use isolated fixture data only, following `docs/verification/README.md`.

1. Owner assignment persists across reload; replacement cannot produce two
   masters. Bot tools cannot assign authority or impersonate the owner.
2. Master discovery, profile/team edits, routine operations, direct messaging,
   coordination and room membership work for sectionless, same-section,
   other-section and Chief targets. Include a synthetic sectionless Chief,
   matching Michael Scott's role. Exercise real injected tool paths.
3. Ordinary Chiefs still fail equivalent out-of-scope operations outside an
   authorized room task. Refusals distinguish missing authority, audience
   mismatch and unavailable targets. Hidden/deleted bots remain guarded.
   Test absent/null/empty/unknown sections, restrictive master peer lists,
   and a fleet larger than 12 with prompt truncation and complete tool discovery.
4. Master edits another Chief's leadership flag subject to leadership guards;
   demoting/deleting the active master is refused until owner revocation.
5. Full Access master edits apply without prompts. Deletion remains pending
   until owner confirmation; spoofed confirmation and stale authority fail.
6. Explicit `approvalMode` edits persist. Default-only preserves overrides;
   valid all-thread updates change the intended existing threads. Verify Ask
   stops active turns, Full refuses busy/pending/incompatible targets, and
   invalid scope combinations fail. Seed an Ask thread stalled on an unanswered
   approval card; record its busy state and the actual permission-edit outcome.
   Verify pending-grant restart revocation and its audit event for both
   thread-only and bot-wide scope. Target execution uses target permissions;
   ordinary edits do not widen them. Master self-permission edits fail.
7. Transfer/revocation during an active turn or pending confirmation removes
   the former holder's fleet authority before the next protected operation.
8. Reload, duplicate requests, invalid providers/modes, stale targets and
   injected persistence failures preserve consistent state and audit receipts,
   including fail-closed widening and retained runtime revocations.
9. Validate the owner promotion and audit surfaces in the real renderer against
   the fixture, including an audit row for a deleted target. Retain screenshots
   and leave those validated tabs open.
10. Master assembles a General + Support room task. Both ordinary participants
    can contribute and receive same-task handoffs. They cannot contact outsiders,
    access prior room history, or use another member's permissions. Test membership
    changes, room-lane work, assignment transfer/revocation, and audience mismatch;
    stale room grants fail before dispatch for every cross-section participant,
    while independently authorized same-section work remains available. An
    unchanged valid room grant survives reload. Include an `admins`-visible
    member against an `everyone`-visible member to exercise a real audience
    conflict, and verify unchanged transcript-feed checks prevent history leaks.

## Review reconciliation

Dr Eggbot reviewed the initial spec (`3f55a51ca`) and requested changes.
The revised contract names the independent access gates, defines functioning
room-scoped cross-section participation, specifies existing all-thread permission
constraints and pending-grant revocation, preserves roster truncation notices,
defines unsectioned/hidden targets, and protects the master's own permissions.

Two recommendations were narrowed after source inspection: making cross-section
rooms master-only would violate the requested room capability, and bypassing
all of `peerAllowed` would also bypass `sameAudience`. The room grant addresses
the former without widening other contexts; the latter privacy check stays.
The source already contains explicit roster omission notices. Grant revocation
also has a thread-only case, which the revised acceptance checks distinguish.

Dr Eggbot's second review of `9196326bc` closed the original objections and
conditioned design-only approval on three room clarifications. Those conditions
are now explicit: membership changes fail closed from every cross-section
participant's perspective, grants leave transcript-feed checks unchanged, and
valid room grants survive reload. The dated fleet-audience observation,
sectionless-Chief fixture, named audience refusal and mixed-audience fixture
also address the accompanying evidence and wording requests. This records
conditional review acceptance, not a new review of implementation or owner
authorization to implement, deploy or assign the live master.

## Delivery boundary

Implementation and verification follow written-spec review. Any live assignment
to Dr Eggbot or deployment is a separate explicitly approved production action.
The production refusal reports, exact approval-mode runtime wiring, and audit
storage integration remain to be verified during implementation discovery.
