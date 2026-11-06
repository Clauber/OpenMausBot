# Local GX10 acceptance

Measured on 2026-11-06 against the isolated St. Paul snapshot. The requested response route is `gx10/claude-haiku-5-5` through 9router. Input speech and output speech both use AllTalk `male_01.wav`. No ElevenLabs engine or agent conversation ran.

Five successful streamed-audio turns out of 8 attempts. All successful turns had a nonempty transcript, snapshot recall, reply text, and nonzero PCM. Failed attempts are excluded from timing statistics and retained in the raw artifact.

| Turn | Transcription ms | First reply token ms | First TTS PCM ms | EOS to PCM ms | Recall passages |
|---|---:|---:|---:|---:|---:|
| 1 | 560 | 2937 | 557 | 4773 | 8 |
| 2 | 249 | 5262 | 528 | 6955 | 8 |
| 3 | 172 | 2396 | 520 | 3777 | 4 |
| 4 | 149 | 3291 | 1113 | 5081 | 8 |
| 5 | 248 | 4150 | 512 | 5535 | 6 |
| Median | 248 | 3291 | 528 | 5081 | |

EOS to first PCM ranged from 3777 to 6955 ms. Reply generation accounts for most of the wait. EOS uses the last server frame above the energy threshold. It includes 500 ms of VAD silence. Transcription includes the SSH transport. The first-token interval starts at the 9router request. TTS starts when a complete sentence is available. These phase intervals omit recall and sentence buffering, so their sum is smaller than the total. First PCM receipt is a server measurement, not acoustic playback latency.

The three failed attempts were an empty model stream, an upstream authentication error mentioning the gateway's Gemini fallback, and an upstream connection timeout. Earlier diagnostic runs also hit connection timeouts. No proxy, model service, or production service was changed. The requested model name is verified at the HTTP request boundary; the gateway's actual upstream model is not independently established.

The harness load was about 16 to 17 across 24 logical CPUs. GX10 was about 0.76 across 20 logical CPUs before the run. This is a single PoC run, not a provider reliability or production capacity claim.

## Verification

- Unit tests passed credit refusal below 100, acceptance at 100, refusal of an unknown balance, and split streaming WAV headers without an ElevenLabs request.
- Scoped oxlint, Node and shell syntax, and Python compilation passed. Standalone TypeScript reported zero PoC errors and 25 errors in untouched product files.
- The canonical isolated CLI fixture passed bot creation, send, a settled wait, and a bounded transcript containing the fake engine reply.
- The HTTPS browser check showed St. Paul and his configured voice by default, all four variants, and both voice providers. A text-injected Local turn scheduled nonzero PCM. Barge-in stopped scheduled sources, hangup ended the microphone tracks, and the browser recorded zero exceptions.
- One permitted 14-character ElevenLabs line, "Hello, Clauber.", returned 65,280 bytes of PCM using `eleven_v4_turbo`. The immediate balance reads were 278 before and after, which does not prove the vendor has posted the final charge. No second ElevenLabs generation was attempted. The final page balance is 270 credits.

## Evidence and limits

Private evidence stays under ignored `.data/`. The reproducible audio test is `local-smoke.ts`; its output is `.data/local-timings.json` and `.data/logs/local-smoke-acceptance.log`. Unit, lint, type-check, CLI fixture, and browser outputs are in `.data/logs/`. Browser screenshots are `.data/local-page.png` and `.data/local-call.png`.

The measurement predates a final change that preserves TTS rejection reasons for display on the page. That change affects the error path only. Successful audio generation and its phase timings are unchanged. The browser recheck after that restart passed with 11 PCM sources started, 9 sources stopped by interruption, ended microphone tracks, and zero browser exceptions.

Human listening, iPhone Safari, noisy-room VAD behavior, and new hosted ElevenLabs conversation calls remain unverified. Native think can still wait for approval in the copied bot thread. Snapshot isolation is not an operating-system sandbox.
