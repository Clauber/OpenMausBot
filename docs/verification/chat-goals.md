# Persistent chat goals and model changes during work

Use an isolated fixture as described in [Chat UI](chat-ui.md). Never exercise
these mutations against a live workspace.

In a bot conversation, type `/goal` and select the command, then enter an
objective. The goal is saved on that conversation and keeps running across
turns until completion, a blocker, a request for input, or an explicit pause
or stop. `/goal status`, `/goal pause`, `/goal resume`, and `/goal stop` control
that conversation's goal. Pause, Resume and Stop buttons also appear above
the composer. Ordinary messages still steer the conversation.

The agent supplies a completion decision and supporting evidence. The harness
does not independently prove arbitrary external outcomes. Three turns with
missing status or unchanged progress block the loop for review. Provider
failures also block it; `/goal resume` retries after the cause is resolved.
Paused goals remain paused after restart, while active goals resume against
the existing conversation. Existing permissions and spend limits still apply.

The composer model and effort pickers remain available during work. Saving a
selection changes the next dispatch, leaving the running provider untouched.
Sending a steering message with a changed selection interrupts the old turn
and dispatches the message once with the new selection. The queued-message
Steer action follows the same rule. Other conversations retain their settings.

Run the permanent server fixtures:

```sh
pnpm exec vitest run server/chat-goals.test.ts server/chat-goals.e2e.test.ts
```

They cover two-turn completion, private protocol removal, command deduplication,
pause/resume/stop, active and paused restart recovery, natural turn boundaries,
effort changes on steering, and switching between synthetic providers. The
fixtures never use a real account. Existing steering, unattended steering,
guarded-message and room-goal tests check neighboring behavior.

For the real renderer, use a fake engine in `hang` mode. Start a goal, open both
pickers while it is running, change effort, and send a steering message. Check
the provider dump for the new selection and that the text appears only once.
Click Pause, Resume, and Stop, and confirm the goal state follows each action.
Use scripted `FAKE_CLAUDE_REPLIES` with a shared `FAKE_CLAUDE_REPLY_STATE` file
for a completion scenario: fresh provider processes must advance the same
reply sequence. Capture the goal card and open effort menu as browser evidence.
