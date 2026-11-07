# Local call round three

Clauber can test Local with Turbo token streaming, a conversational Haiku listener, and Jev-gated background work. This remains an isolated PoC. It changes no product code or live app data.

## Protocol and roles

`eleven_v4_turbo` rejected the older `/v1/text-to-speech/{voice}/multi-stream-input` endpoint with HTTP 400. The vendor response directed callers to text-to-dialogue. The implemented endpoint is `/v1/text-to-dialogue/multi-stream-input?model_id=eleven_v4_turbo&output_format=pcm_24000`. A short `[curious] Hello there.` probe returned 49,920 PCM bytes.

One connection lasts for the call. Each reply initializes a `context_id` with `voices`, streams `inputs` containing `text` and `voice_id`, then sends `flush` and `close_context`. Cancellation removes that context and ignores late audio. The dialogue protocol buffers about 40 characters and eight words. It has no TTS chunk schedule or auto-mode setting. Local has no HTTP fallback and never substitutes another model.

Haiku talks to the caller and proposes a short self-contained task through the existing `think` schema. Local treats that schema as a proposal, so it needs no second task-writing model call. Jev runs in parallel and alone authorizes work at probability 0.6 or above. If the task proposal is not ready, the job receives the latest user turn plus the full call history. The worker is the copied St. Paul agent. Hangup owns its cancellation signal. Additional jobs queue serially.

The gate reuses `server/decider/jev.ts`, including its validation, instead of adding a second parser. Its state keeps the latest 16,000 bytes of the conversation, up to 4,000 recall characters, and four pending task summaries. It fails open to no job within 1.5 seconds. Logs label the raw top probability separately from the policy choice.

## Acceptance evidence

The executable source fingerprint is `c602a16054acf1644ac15fbc425e678c5a8dbdf7d1117996869e448a4d907d3f`. It hashes the Git index entries for the 23 PoC TypeScript, JavaScript, and HTML files. Documentation and evidence metadata are excluded. `.data/round3-source.json` records the entries.

| Check | Result and evidence |
|---|---|
| Tags and AllTalk | Unit tests preserve one approved tag across token boundaries, strip other tags, hide displayed and saved tags, and exercise the real AllTalk request builder. `.data/round3-unit.tap`. |
| Jev parser and failure behavior | Tests exercise the product backend parser, invalid probabilities and choices, the 0.6 boundary, and a hard timeout even if fetch ignores abort. `.data/round3-unit.tap`. |
| Background lifetime and queue | Tests prove a new turn preserves the job, hangup cancels it, results enter history, and queued jobs never overlap. `.data/round3-unit.tap`. |
| Empty transcripts and merging | Tests preserve a reply after empty or tag-only transcripts, release audio buffered during transcription, and merge segments within 1.5 seconds before first audio. `.data/round3-unit.tap`. |
| Empty TTS | A test reproduced silent completion without audio. The session now reports a synthesis error. `.data/round3-unit.tap`. |
| Real background work | The final text-injected AllTalk call completed the fresh file hash in 10,705 ms while surviving "Hello?", then returned the matching hash in spoken PCM. It produced 1,749,504 PCM bytes across the call. `.data/round3-text.json` and `.data/round3-text-final-stack.log`. |
| Real tagged Turbo playback | Electron drives the actual HTTPS page with a synthetic silent microphone and a tagged reply request. Browser audio scheduling is instrumented. Tags are absent from displayed transcripts. `.data/round3-ui.json`, `.data/round3-call.png`. |
| Library reach | Search `warm` returned 20 matches with previews and more results. Adding Rodolfo - Warm succeeded, increasing account voices from 26 to 27. Current readback confirms it remains selectable. `.data/round3-library.json`, `.data/round3-library.png`. The full-slot error is mocked in a unit test. |
| Existing checks | Both existing Local tests still pass. All 14 tests pass. `.data/round3-unit.tap`. |
| Product verification | `.claude/skills/verify-omb/SKILL.md` and `docs/verification/README.md` were followed. Doctor passed on an isolated fake-engine fixture and the separate copied-bot dev instance. `.data/round3-doctor-fixture.json`, `.data/round3-doctor.json`. |

Private context, transcripts, screenshots, and audio stay in ignored `.data/`. The committed scripts reproduce the checks. The library addition is not repeated because it consumes an account slot. Its implementation did not change after the successful add.

## First token to first audio

Three matched short turns used George and Turbo. Each new-path turn produced "Yes, I can check that. Then we can decide together." The HTTP baseline replayed that turn's exact text cadence through the old sentence splitter. Each side had a warm balance cache. Both returned nonzero PCM in every pair.

| Pair | WebSocket, ms | Sentence HTTP, ms | WebSocket PCM bytes | HTTP PCM bytes |
|---|---:|---:|---:|---:|
| 1 | 357 | 397 | 172,800 | 172,800 |
| 2 | 354 | 408 | 172,800 | 180,480 |
| 3 | 382 | 415 | 172,800 | 176,640 |
| Median | 357 | 408 | | |

The observed median difference is 51 ms. The ranges are 354 to 382 ms and 397 to 415 ms. These are three controlled samples, not a general speedup claim. Vendor buffering and network synthesis remain in the interval. The HTTP timer begins at the first displayed token, within one millisecond of the server's first-token timestamp in these samples. Neither interval measures sound reaching a person's ear.

The host had 24 available cores and load around 21 to 22 during the final samples. The paths alternate within each pair. They use the same words and token timing, rather than independent LLM answers. The baseline uses the historical per-sentence HTTP behavior. It does not measure a hypothetical optimized HTTP implementation.

Earlier comparisons incorrectly included a cold balance lookup only on the HTTP side. Those timings were discarded. The final script warms that cache with a zero-character reservation before its timer. The table comes from `.data/tts-sample-1.json` through `.data/tts-sample-3.json` after that correction. Two earlier sets of three pairs were run during verification. No automated multi-call ElevenLabs loop ran.

## Quality review and limits

The complete staged diff, including new files, received the thermo-nuclear maintainability review and deslop pass. No open structural finding remains. `LocalSession` owns foreground and background lifetimes, while the vendor module owns audio contexts. The largest PoC source file is 277 lines. The review retained the vendor protocol and browser echo comments because they describe external constraints. No correctness lint rule was suppressed.

The review fixed empty-audio completion, tags in user transcripts and merge notices, and a test-only Jev key being blocked by an absent live config file. Scope checks and redacted secret scans pass. Independent review was not performed because this implementation child must work without further delegation. The evidence manifest reports `TECHNICAL_PASS_RELEASE_BLOCKED` while independent review and manual phone acceptance remain open.

Results wait for the current short foreground reply and its scheduled playback to finish. They do not cut into already buffered speech at an earlier sentence boundary. Playback timing uses scheduled PCM duration, without a browser acknowledgment of audible completion. Human listening quality, iPhone Safari, noisy-room recognition, and a real voice-slot-exhaustion response remain unverified. Hosted Agent and Engine model settings use the shared Turbo constant, but their billable calls were not rerun.

One repeated directory-listing smoke request received Jev direct at 0.51 and started no job. The fresh file-check request proved the background path. This is not a classifier-quality evaluation. Fail-open decisions can leave a proposed check unstarted. Unused provider probes also report known quota failures for OpenAI, Gemini, and several compatible routes. The selected direct Haiku route and Turbo path returned replies.

## Credits and handoff

The observed starting balance was 119,860 credits. The final readback was 119,587 credits at 2026-11-07T01:02:07.624099+00:00, an observed decrease of 273 credits. This stays below the 3,000-credit limit. Vendor balance updates can lag. The process-local estimate reserves 0.5 credit per character and does not constrain spending by another client.

Read `.data/run.json` for the current private HTTPS URL, dev port, PoC port, snapshot path, and exact owned PIDs. Stop only its supervisor with the printed `kill -TERM PID` command. The final URL returned HTTP 200. Supervisor 462409 owns dev port 36465 and PoC port 44955. Stop it with `kill -TERM 462409`. Nothing was merged or deployed.

## References

- [Realtime text-to-dialogue guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tdd).
- [TTS and dialogue WebSocket comparison](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/tts-vs-ttd-websockets).
- [Dialogue multi-context endpoint](https://elevenlabs.io/docs/api-reference/text-to-dialogue/ttd-multi-websocket).
- [Decision trail](decisions-round3.tsv).
- [Executable acceptance spec](.spec.md).

The installed ElevenLabs server SDK is 2.76.0 and Electron is 43.7.9. Official protocol documentation and successful vendor responses established the implemented endpoint. A follow-up Context7 request timed out. The comparison page also contains stale text about v4 context support, so the endpoint reference and successful live probe take precedence.
