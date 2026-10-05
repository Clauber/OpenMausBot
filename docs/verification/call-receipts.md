# Live call receipts and ask_compute verification

Use Node 24 or later and an isolated fixture. Never target live workspace data
or a real OpenAI key: the fixture uses the fake GPT-Live
(`server/testing/fake-openai-live.ts`) and the repository's fake engines.

```sh
pnpm typecheck
pnpm exec vitest run server/call-receipts.e2e.test.ts server/live-call-controller.test.ts \
  server/live-call.test.ts server/live-call.e2e.test.ts shared/call-receipt.test.ts \
  src/components/CallReceiptCard.test.ts
node --experimental-strip-types scripts/verify-call-receipts.ts
```

The script launches the fake GPT-Live and a `control-omb` fixture (the
loopback `OMB_OPENAI_LIVE_URL` is the one live-call variable that crosses into
the child), runs the flows below over the real HTTP routes and sideband, prints
`evidencePath` (request/response JSON) and `logPath`, and stops both fixtures.

## What is pinned

- **Receipt.** Every call that connected ends with exactly one `call_receipt`
  message in the bound thread: call id, bot, thread, start/end, duration (the
  session's reported seconds), outcome, end reason, error, the per-side
  transcript lines and the ask_compute requests. The same data is written to
  `<data dir>/call-receipts/<callId>.json` (mode 600). Lines are scrubbed with
  the bot-authored secret redaction before either is written; the server log
  still carries counters only.
- **Late transcript.** After the call ends the sideband stays up for
  `LATE_TRANSCRIPT_MS` (3 s). Transcript deltas that arrive in that window
  rewrite the same receipt message (`message.patch`); they never add a second.
  The fake's `setCloseLinger(ms)` holds the socket open after `session.closed`
  so a test can send them.
- **ask_compute.** While the bot's switch is on, the session is created with
  an `ask_compute` function tool. The fake sends it with
  `callTool(sessionId, "ask_compute", { request })` (event
  `session.tool_call.created`); the harness sends the turn through the same
  path a spoken request takes (steer, queue or start, with `via: "call"` and a
  `sendId` of `ask_compute-<callId>-<n>`), so the engine runs a normal, visible
  turn on the thread. The answer returns as `session.tool_call.output`
  (`{ ok, answer | error }`, read with `waitForToolOutput`); it is not also
  spoken as commentary.
- **Caps.** At most 6 turns per call (a 7th is refused and never sent), one at
  a time, 90 s per delegation. The 90 s budget is paused while an approval or
  question card is open and resumes when it settles.
  `OMB_ASK_COMPUTE_TIMEOUT_MS` (500 to 89,999) can only shorten it, for fixtures.
- **Approval mode.** The thread's approval mode applies unchanged: a call in
  Ask mode shows the normal approval card, the voice asks for a yes/no, and the
  turn does not run until it is answered.
- **Kill switch.** `PATCH /api/bots/:id { liveCompute: false }` (Settings ->
  voice -> "Do work during calls", default on) removes the tool from new calls
  and refuses a call to it.

## Test map

| Check | Where |
| --- | --- |
| (a) one receipt with lines and duration | `call-receipts.e2e.test.ts` (a) |
| (b) late transcript updates, not duplicates | (b), and the controller unit test |
| (c) compute turn visible, summary returned | (c) |
| (d) 7th refused; timeout path | (d); 90 s and paused clock in the controller tests |
| (e) Ask mode shows the approval card first | (e) |
| per-bot switch | (f) |

Run the targeted tests only; the full suite is outside this ticket's gate.
