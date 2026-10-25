# Taught skills

Choose a ready, explicitly bound Local VM, local computer or cloud computer.
In the Computer panel, enter a task title and optional narration notes, then
click **Start recording**. Use **Demonstrate an action** and **Perform action**
to demonstrate the task through that computer's native tools. Computer tool
calls from an active bot are also captured through its existing MCP bridge.
**Stop and save** creates a playbook; **Discard** drops the recording.
Raw desktop-viewer mouse/keyboard traffic is not a driver tool call and is not
recorded by this MVP. Recording sessions are temporary until saved.

The Skills area lists taught playbooks and the last ten runs per bot. **Replay**
checks that the bound computer is reachable and has the recorded kind. The
first replay displays the standard learned-skill approval card in the bot's
conversation. Review the complete recorded arguments and click **Enable**:
approval starts that run. **Deny**, or deleting its conversation, rejects the
pending run. Later replays reuse approval for that bot. **Always ask before
replay** requests a new card for every run, including bots with Full Access.
Disabling/removing the bot's approved skill requires another review on replay.

Steps execute in request order through the existing tool transport. An error,
element-not-found or navigation failure stops the run, reports its zero-based
failed index and human-readable step number, and prevents later dispatches.
There is no automatic retry or resume. Inspect the desktop before a new run.
Optional screenshot comparison uses exact image hashes; enable it only for
deterministic screens. A different or missing expected image stops the run.

Each library entry has `kind: "taught"`, an immutable `playbook.json` and
`SKILL.md` containing the kind, notes, exact ordered actions and manifest hash.
Screenshots returned as MCP images are private, content-addressed base64 files
under `skills-library/taught-screenshots/`. Replay state, per-bot approval and
history are saved atomically in `skills-library/taught-state.json`. The approval
card binds the reviewed summary to the manifest's exact bytes. Editing either
file invalidates replay. A restart fails an interrupted run without resuming it;
pending approval cards and their associated run survive restart.

Replay uses the bot's current conversation approval mode, existing computer
ownership/control gates and managed computer restrictions. A changed binding,
approval mode, human takeover or competing desktop claim stops dispatch.
Shell and download tools are excluded, including composite `act` operations
containing unsupported actions. `registerTaughtRuleGuard` is the optional
LEGION-9 integration point: an installed rules layer receives each step and
the current approval mode before dispatch; a rejection stops the run. This
base has no LEGION-9 implementation. Notes and recorded arguments must not
contain credentials; secret-like arguments are refused.

The MVP supports at most 256 steps and 16KB per action, within the existing
32KB approval-summary limit. It supports same-kind replay with the same native tool
names; it does not translate coordinates or selectors between providers.
Cross-provider replay, narration TTS, editing/reordering steps, pixel-diff
tolerance and raw desktop-viewer recording are deferred.
