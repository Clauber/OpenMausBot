# Round-two decision

Choose a lower-latency call path that preserves bot identity, memory and a think tool to the full agent. Compare EOS to the first real answer audio through the current isolated tunnel. Acknowledgments do not count.

## Scope

Only poc/voice-call changes. Keep live data read only and never contact port 8799. Retain the current snapshot and thread. No merge or deploy. Credentials remain in-process or in ignored .data.

Settings are call-scoped. Cache mode, context mode, call topic, turn eagerness, timeout and speculative generation are logged with every turn. Full and slim response contexts preserve identity and SOUL. Slim selects memory once at call start and uses ten recent messages. Think retains the full bot agent.

Anthropic stable system blocks have explicit cache breakpoints. Prewarming uses the identical model, tools and system prefix. Log input, cache-read and cache-creation tokens. Streaming emits each model text delta without sentence accumulation. Disable response-model thinking.

Probe ElevenLabs Realtime and configured Live routes before displaying them. Failed probes retain HTTP status. Never publish credentials in config responses or logs.

## Measurement

A faster setting requires an effect larger than observed spread. Otherwise report overlap. Interleave calls. Record host load, caller/server CPU time and phase timestamps. Keep round-one scripted_pcm_end and websocket_audio_arrival_proxy signals. Mark real answer audio separately. Filler or pre-tool model speech must not masquerade as the answer. Missing hosted internal timestamps remain unknown.

Run at least eight small-talk and five memory-question turns per compared setting. Best two also run interruption and read-only local tool scenarios. Count errors, retries, cancelled speculative generations and missing marks. Private transcripts remain ignored.

## Checks

- Every enabled variant completes a real tunnel call with full context and think available.
- Cache usage proves cache reads on measured cached calls.
- Slim input usage is lower and identity/SOUL remain complete.
- Each setting reaches eight small-talk and five memory turns, with failures reported.
- Per-phase report includes median, p90, range, sample size and limiting phase.
- Best two complete interruption and tool scenarios or record concrete failures.
- Test-page settings work and real target screenshots are retained.
- Canonical isolated fixture verification, scoped typecheck, lint and final diff review pass or disclose limitations.
- Staged files and PR diff remain under poc/voice-call. Attribution and secret gates pass before commit and push.
- Leave the owned stack running with URL, PIDs and exact stop command.
