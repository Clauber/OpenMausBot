# Continue work after a service restart

Running bot turns and room operations are written to `running_turns` in
`messages.db` before provider dispatch. Each row binds a conversation to its
dispatch generation and original message. Scheduled runs and room goals also
retain their run IDs. Completion removes only the matching generation; Stop
and conversation deletion remove its recovery intent.

On startup, unfinished work resumes through normal admission and current
permissions. The model receives the existing conversation and a service
restart nudge: continue from the last state, inspect effects that may already
have happened, and do not repeat the original request blindly. The transcript
shows a restart activity notice, without adding another user message. This
does not guarantee exactly-once external tool effects; those must be checked
by the model. A failed recovery attempt is reported and does not spin.

Active chat goals retain their existing continuation owner. Room goals reuse
their card and turn limit. Scheduled work reuses its run instead of creating
another execution. Queued user messages keep priority and inherit the nudge
when they become the next dispatch. Stopped, completed, deleted, and archived
bot tasks do not restart.

Use only isolated fixtures, never live user data:

```sh
pnpm exec vitest run server/turn-recovery.test.ts server/turn-recovery.e2e.test.ts server/chat-followups-restart.test.ts server/chat-goals.e2e.test.ts server/room-recovery.e2e.test.ts
```

The restart fixtures terminate the server with both SIGKILL and SIGTERM,
relaunch the same disposable home, verify the recovery instruction reaches
the fake provider, and confirm request/run identity, terminal cleanup, and
explicit Stop behavior. Fake providers exit when their input pipe closes.

For browser evidence, use the chat fixture with a hanging fake provider,
send a request, restart only that fixture in happy mode, and inspect the same
conversation. Capture the restart notice and completed reply; leave the
validated conversation open.
