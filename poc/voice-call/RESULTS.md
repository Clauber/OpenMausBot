# Voice-call experiment results

Clauber wants calls to use the same bot identity, memory, thread and ElevenLabs voice as chat. This is a throwaway comparison instrument. The coordinator owns the architecture recommendation.

The comparison is inconclusive for production performance. One complete matrix pass ran on 2026-11-06 UTC. All 25 calls were attempted and 22 passed the caller's transport, reply and required-thinking checks. These checks do not certify every spoken fact.

| Configuration | Hello | Memory | Tool | Interrupt | Long call | Call checks |
|---|---|---|---|---|---|---|
| Engine, Haiku, buffer off | Pass | Pass | Pass | Pass | 181.100 s | 5/5 |
| Engine, Haiku, buffer on | Pass | Pass | Pass | Pass | 181.151 s | 5/5 |
| Engine, 9router GLM Flash, buffer off | Pass | Pass | Failed | Failed | 238.009 s | 3/5 |
| Engine, 9router GLM Flash, buffer on | Pass | Pass | Pass | Failed | 273.417 s | 4/5 |
| Agent, Gemini Flash Lite | Pass | Pass | Pass | Pass | 180.182 s | 5/5 |

Each long call sent nine synthesized user utterances and received audio replies. The interrupt scenario observed real interruption events for both Haiku settings and the hosted agent. Four successful tool scenarios produced native read-only file listings inside the copied workspace. All five memory calls completed bot thinking. The factual omission described below still applies.

The GLM buffer-off tool call timed out after 139.206 seconds without a completed audio reply or a think call. Its interrupt call produced no audio to interrupt. With the buffer on, the GLM interrupt call produced no substantial reply to interrupt. Their recorded errors are preserved in `.data/logs/scripted.jsonl`. Their causes were not established.

## Comparable speech-end measurements

This subset uses `scripted_pcm_end` and `websocket_audio_arrival_proxy` throughout. Values are milliseconds. Each setting had five calls covering different scenarios, not five independent repetitions of each scenario.

| Configuration | Audio n | First audio median / p90 | Audio range | Text n | First text median / p90 | Text range |
|---|---:|---:|---:|---:|---:|---:|
| Engine, Haiku, buffer off | 13 | 1763 / 3272 | 1136 to 3463 | 13 | 1476 / 2911 | 771 to 3215 |
| Engine, Haiku, buffer on | 12 | 310 / 426 | 46 to 431 | 11 | 151 / 263 | 3 to 269 |
| Engine, GLM Flash, buffer off | 11 | 6588 / 10990 | 4043 to 11741 | 11 | 5918 / 10356 | 3136 to 11489 |
| Engine, GLM Flash, buffer on | 12 | 276 / 343 | 41 to 409 | 9 | 124 / 225 | 25 to 225 |
| Agent, Gemini Flash Lite | 14 | 1181 / 1542 | 807 to 1724 | 14 | 1274 / 1710 | 910 to 1841 |

The buffer measurements usually time an acknowledgment. Four buffer text timestamps preceded the end of synthesized PCM and were excluded as negative intervals. Hosted text is client receipt; engine text is server send. The report below preserves the other EOS groups instead of pooling them into this subset.

Across all EOS groups, completed bot thinking ranged from 4,399 to 33,061 ms. During a sampled interval, the PoC and caller averaged about 1.2% and 2.4% CPU. The host load was about 51 on 24 available cores. The exact provider, network and scheduling bottleneck was not isolated, so these configurations do not establish an architecture speed ranking.

## Raw report output

Command: `poc/voice-call/node_modules/node/bin/node --experimental-strip-types poc/voice-call/report.ts`.

| Variant | Buffer | Response / hosted LLM | Thinking | EOS signal | Audio signal | Turns / audio | First audio median / p90 ms | First text median / p90 ms | Think completed / called | Think median / p90 ms | Interrupted | Failed |
|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| engine | off | claude-haiku-5-5 | bot | client_speech_in_progress | none | 2 / 0 | n/a | n/a | 0 / 2 | n/a | 2 | 0 |
| engine | off | claude-haiku-5-5 | bot | scripted_pcm_end | websocket_audio_arrival_proxy | 14 / 13 | 1763 / 3272 | 1476 / 2911 | 1 / 1 | 10028 / 10028 | 1 | 0 |
| engine | on | claude-haiku-5-5 | bot | scripted_pcm_end | websocket_audio_arrival_proxy | 15 / 12 | 310 / 426 | 151 / 263 | 0 / 2 | n/a | 3 | 0 |
| engine | on | claude-haiku-5-5 | bot | server_transcript_arrival | websocket_audio_arrival_proxy | 4 / 3 | 163 / 171 | 1 / 1 | 2 / 3 | 9766 / 12705 | 1 | 0 |
| engine | off | 9router:glm/glm-5.3-flash | bot | scripted_pcm_end | none | 3 / 0 | n/a | n/a | 0 / 0 | n/a | 1 | 1 |
| engine | off | 9router:glm/glm-5.3-flash | bot | server_transcript_arrival | websocket_audio_arrival_proxy | 1 / 1 | 13404 / 13404 | 10708 / 10708 | 1 / 1 | 15151 / 15151 | 0 | 0 |
| engine | on | 9router:glm/glm-5.3-flash | bot | scripted_pcm_end | websocket_audio_arrival_proxy | 14 / 12 | 276 / 343 | 124 / 225 | 2 / 2 | 9818 / 12803 | 1 | 1 |
| engine | on | 9router:glm/glm-5.3-flash | bot | server_transcript_arrival | websocket_audio_arrival_proxy | 3 / 1 | 173 / 173 | 0 / 0 | 1 / 1 | 9469 / 9469 | 2 | 0 |
| agent | off | gemini-3.1-flash-lite | bot | scripted_pcm_end | websocket_audio_arrival_proxy | 15 / 14 | 1181 / 1542 | 1274 / 1710 | 7 / 8 | 9599 / 13329 | 1 | 0 |
| engine | off | 9router:glm/glm-5.3-flash | bot | scripted_pcm_end | websocket_audio_arrival_proxy | 11 / 11 | 6588 / 10990 | 5918 / 10356 | 0 / 0 | n/a | 0 | 0 |
| engine | off | claude-haiku-5-5 | bot | scripted_pcm_end | none | 1 / 0 | n/a | n/a | 0 / 1 | n/a | 1 | 0 |
| engine | off | claude-haiku-5-5 | bot | server_transcript_arrival | websocket_audio_arrival_proxy | 2 / 2 | 2470 / 3192 | 1753 / 2022 | 1 / 1 | 33061 / 33061 | 0 | 0 |
| engine | on | claude-haiku-5-5 | bot | client_speech_in_progress | websocket_audio_arrival_proxy | 2 / 0 | n/a | n/a | 0 / 0 | n/a | 2 | 0 |
| engine | off | 9router:glm/glm-5.3-flash | bot | client_speech_in_progress | none | 1 / 0 | n/a | n/a | 0 / 0 | n/a | 1 | 0 |
| engine | off | 9router:glm/glm-5.3-flash | bot | server_transcript_arrival | none | 3 / 0 | n/a | n/a | 0 / 0 | n/a | 2 | 1 |
| engine | on | 9router:glm/glm-5.3-flash | bot | client_speech_in_progress | websocket_audio_arrival_proxy | 1 / 0 | n/a | n/a | 0 / 0 | n/a | 1 | 0 |
| engine | on | claude-haiku-5-5 | bot | server_transcript_arrival | none | 1 / 0 | n/a | 0 / 0 | 0 / 0 | n/a | 0 | 0 |

Event errors: 3. Interrupted and failed turns are excluded from latency percentiles. Missing or negative intervals are excluded, never counted as zero. WebSocket audio arrival and browser speaking mode are proxies for audio playback. Hosted first text is client receipt because the hosted LLM does not expose server-send timestamps.

## Acceptance evidence

| Requirement | Observed result | Local evidence |
|---|---|---|
| Both variants on the tunnel page | Real WebRTC connections and spoken responses; no browser exceptions | `call-engine.png`, `call-agent.png`, `logs/ui-engine.json`, `logs/ui-agent.json`, `logs/ui-errors.json` |
| Same voice and full context | Both remote resources use the configured voice; agent prompt readback had 138,012 characters; full SOUL and all 15 memory files included | `logs/eleven-readback.json`, `logs/context-validation.json` |
| Safe snapshot and fresh sessions | Neutralization checks passed; current dev cursor shares no live cursor and retains the copied thread | `logs/snapshot-validation.json`, `logs/final-cursor-validation.json` |
| Five scenarios across five settings | 25 distinct call IDs, 22 call-check passes, three recorded failures; all long calls exceeded 180 seconds | `logs/scripted.jsonl`, `logs/matrix-validation.json` |
| Actual bot tools and memory | Five completed memory lookups and four native copied-workspace file listings | `logs/tool-validation.json`, `logs/transcripts.jsonl`, `omb/events/` |
| Timestamp collection and reproducible report | JSONL merged by call and generation; raw output pasted above | `logs/calls.jsonl`, `report-final.md` |
| Isolated repository verification | Canonical fixture doctor and CLI turn completed | `logs/fixture-bots.json`, `logs/fixture-run.json` |
| Final checks and running services | Scoped typecheck and shell syntax passed; health 200; unauthenticated think 403 | `logs/typecheck.log`, `logs/final-health.json` |

All evidence paths are relative to `.data/` unless explicitly prefixed. Private transcripts, runtime state and screenshots remain local and ignored. Browser evidence predates the final server collector and cancellation fixes; the page and client did not change. The final scripted matrix exercised those fixes through the tunnel. There was no iPhone or human listening acceptance.

Manual quality review found no blocking structural issue for this throwaway scope. The largest source file is 245 lines. No product file changed. A duplicate unreachable model-count guard was removed, and the single vendor packet-limit comment was retained. No independent review was performed. This artifact is ready for architecture review with the failures and limits recorded here, not for production integration.

The matrix predates two startup-only lint cleanups, removal of an unnecessary array copy and replacement of a conditional expression with `if`/`else`. The final server was restarted. All model probes and one real hello call per variant passed again. These extra calls are in `.data/logs/post-lint-scripted.jsonl` and `post-lint-calls.jsonl`, excluded from the table. The original and final source hashes are in `.data/source-sha256.matrix.txt` and `.data/source-sha256.txt`. Call handling did not change. The final lint check passed and the frozen report output was unchanged.

## Evidence retained locally

- `.data/logs/calls.jsonl` contains timestamped final-run turn events. `.data/logs/scripted.jsonl` contains the scenario outcomes and audio counts. Diagnostic runs have separate filenames and are excluded from the final report.
- `.data/logs/transcripts.jsonl` contains private user and spoken agent transcripts. `.data/omb/events/` contains the isolated bot's real engine and tool events.
- `.data/page-engine.png`, `.data/page-agent.png`, `.data/call-engine.png` and `.data/call-agent.png` contain real HTTPS page screenshots. `.data/logs/ui-engine.json`, `ui-agent.json` and `ui-errors.json` contain browser outcomes.
- `.data/logs/dev-first-turn.json` proves the copied bot completed a turn in its original copied thread with a fresh engine cursor. The live cursor was not reused.
- `.data/logs/fixture-bots.json` and `fixture-run.json` record the canonical fake-engine CLI verification. The fixture doctor and turn passed. Its launcher was then stopped by exact PID.
- `.data/logs/snapshot-check.log` records a second execution of the current snapshot script into ignored scratch space. `snapshot-validation.json` verifies its empty MCP map, absent bot resume cursors, disabled recovery and zero rows in `chat_followups`, `command_receipts` and `running_turns`.
- `.data/model-probes.json` and `.data/hosted-probes.json` record successful startup probes. `.data/logs/full-probe.jsonl` records the two 9router models accepting the full context.
- `.data/logs/typecheck.log` records the scoped TypeScript check. The server import graph has 25 product diagnostics and no diagnostic under `poc/voice-call/`, recorded in `server-typecheck.log`. This is not a clean repository typecheck.

## Findings that changed the experiment

The full context exceeded the ElevenLabs browser client's 64 KB WebRTC packet limit. Uploading the hosted agent's complete system prompt through the server API before joining avoided that limit. Both variants then connected and produced replies from the tunnel page with no browser exceptions.

Groq answered a short startup probe but rejected the complete context with HTTP 413 because its 8,000-token-per-minute limit was below the roughly 33,000-token request. The two-model engine matrix therefore uses Anthropic Haiku and 9router GLM Flash. The model pickers also retain the probed Groq route for explicit failure comparison. See the README for every failed probe status.

Speech Engine's default four-second cascade timeout produced retries and a `Speech Engine generation failed` disconnect during a bot lookup. The final setup uses the documented 15-second maximum and sends whitespace every five seconds while the thinking result is pending. A complete memory lookup then returned real audio.

The scripted caller must wait for both the final transcript and the duration of queued PCM. Waiting only for a quiet network socket can interrupt playback or hang up before the final answer arrives. The final caller also distinguishes its own normal shutdown from a server failure.

The runtime may cancel speculative Speech Engine generations when a later transcript arrives for the same speech. Those cancelled attempts remain visible in the logs. The report excludes interrupted and failed attempts from latency percentiles and completed-thinking latency.

An early collector reused a timing row when a generation finished without sending text. A replacement could then inherit that generation's completion timestamp. Every generation now has its own row. The earlier data remains in `generation-diagnostic` files and is excluded from the final table. Aborting a thinking request now interrupts its exact dev thread before releasing the thinking slot.

In the final hosted small-talk call, the agent greeted the caller and then raised old thread work without being asked. Its answer about its role matched the copied identity. This is a context-selection issue to weigh alongside latency. The private transcript is retained locally, rather than published with this report.

All five memory calls completed thinking and returned team and working-style facts. The first two answers missed a shared-folder fact present in three copied memory files. A later local search recovered it. The calls share an evolving dev thread, so later answers benefited from that correction. This is not proof of exact memory continuity or five independent recall trials. Some engine replies also contained both a model-generated holding line and the PoC's holding line before the answer.

The dev runtime created a local MausBot incident thread and retried a failed dev turn during the first memory call. The native event log records its `retry_thread` request against the copied thread. Disabling `automaticRecovery` does not disable this product incident mechanism. This adds retry variance to the bot-thinking measurements.

## Limits

WebSocket audio arrival and browser speaking mode approximate playback. Scripted EOS is the end of synthesized PCM, which can contain trailing silence. Server-transcript EOS groups omit the earlier speech-end and transcription delay. Compare like signal sources. No iPhone speaker or human listening test was performed. The host was busy, with a load average around 48 on 24 available cores. Provider/network latency, changing thread context and speculative transcript handling also affect the result. The experiment can compare these configurations, but it does not establish a production performance winner.

The isolated bot keeps its configured model and native CLI tools. External integrations, proactive work and live resume state are disabled. Tool requests in this experiment are read-only and name the copied workspace. Isolation uses separate data and HOME directories, disabled integrations and ask permissions. It is not an operating-system or network sandbox. A production implementation would need a deliberate context, cancellation and external-action design.
