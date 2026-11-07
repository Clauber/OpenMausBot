# Voice-call architecture experiment

Clauber wants a phone call to feel like talking to the bot he already chats with, with the same identity, memory, thread and voice. This throwaway prototype compares Local GX10, ElevenLabs Agents, ElevenLabs Speech Engine, and ElevenLabs Realtime Mini. It changes no product code.

## Talk to St. Paul with Local

1. Run `poc/voice-call/start.sh` and open the HTTPS URL it prints.
2. Keep **St. Paul** and **Local (GX10)** selected. The voice defaults to his configured ElevenLabs voice.
3. To avoid ElevenLabs charges, select an **AllTalk** voice, such as **AllTalk / male_01.wav**.
4. Press **Call**, allow microphone access, and speak. Pause for half a second to finish a turn. A new transcript with words interrupts playback.
5. Press **Hang up** when finished.

Local sends mono 16 kHz PCM over the private page's WebSocket. The PoC applies energy VAD with a 500 ms silence window. GX10 transcribes with cached `faster-whisper-small` 1.2.1 on CUDA FP16. Every transcript runs the product's `buildRecall` against the isolated snapshot. The Response picker defaults to direct Anthropic `claude-haiku-5-5`. Its other choice, `cliproxy:gpt-6-luna`, uses GX10 CLIProxy with `CLI_PROXY_API_KEY`. The turn-taking controls apply to the other variants. Local uses its own VAD settings.

Haiku holds the full call history and answers in one or two short spoken sentences. Its `think` tool only proposes a self-contained task. Local never executes that tool directly. Reusing the existing proposal format keeps one reply stream and avoids another task-writing model call. Jev independently decides whether new full-agent work is needed, in parallel with the reply. It receives recent full-call context clipped to 16,000 bytes, recalled passages, and pending tasks. It starts work only when its agent option reaches 0.6. Missing credentials, invalid answers, errors, and a 1.5-second timeout start no job. `listener.ts` exposes the small `ListenerGate` interface for another gate implementation. Jev reads `decider.key` from live config read-only, with an optional `OMB_JEV_API_KEY` override.

The full agent uses the copied bot's existing `think` path. Local always uses thinking model `bot`. It starts with Haiku's proposed task if available, otherwise the latest user turn, plus the full conversation. Haiku can say "Let me check on that" while the job runs. New turns, including "Hello?", leave it running. Hangup cancels it. Additional tasks queue serially. Results play after the current short reply and scheduled audio finish, start with "Okay, I checked", and enter history. The page logs Jev decisions and job start, completion, and duration.

ElevenLabs Local uses `eleven_v4_turbo` through one persistent text-to-dialogue WebSocket per call. Each reply has its own `context_id`. Tokens reach `inputs` immediately, the reply ends with `flush` and `close_context`, and interruption closes only that context. The older text-to-speech WebSocket rejects Turbo and directs callers to the dialogue endpoint. The dialogue endpoint buffers about 40 characters and eight words. Its protocol has no TTS `chunk_length_schedule` or auto-mode setting. There is no Local HTTP fallback. `eleven.ts` owns the model constant, vendor requests, and connection.

Only ElevenLabs receives the optional voice-tag prompt. At most one approved tag reaches TTS per reply: `[laughs]`, `[sighs]`, `[exhales]`, `[curious]`, `[excited]`, `[sarcastic]`, or `[whispers]`. Tags stay intact across token boundaries and disappear from displayed and saved speech. Most replies need no tag. AllTalk receives no tag instruction and strips all square-bracket tags before its existing sentence-based streaming API at `http://100.64.0.9:7851`. AllTalk voices require Local. Hosted Agent and Speech Engine settings share the Turbo constant. Realtime Mini manages its own TTS model.

The voice picker contains account voices from `/v2/voices`. Use **Search ElevenLabs library** to search shared voices by name or description. Open **Preview voice**, then choose **Add and use**. Adding a voice consumes an account voice slot. A full account gets an error explaining that an unused voice must be removed in ElevenLabs. The call freezes its voice when it starts.

A noise segment cannot cancel a reply before transcription confirms words. Empty transcripts preserve the reply. If another segment starts within 1.5 seconds of the previous speech end, before first audio, Local merges the transcripts and answers the combined turn. Audio that arrives while this decision is pending waits for transcription.

The page shows the ElevenLabs credit balance. The server refuses TTS if the balance is unknown or below 100 credits. It reserves an estimated 0.5 credit per character before sending each text chunk and refreshes the vendor balance every 30 seconds. This is a process-local estimate, not a vendor spending cap. Balance updates can lag, and another client can spend credits. Local with AllTalk uses no ElevenLabs generation. Startup lists voices and configures retained hosted resources without conversation probes. Do not run the historical `scripted-calls.ts` matrices for routine checks.

The launcher copies `stt.py` into `~/scratch/voice-poc-stt` on GX10 and runs it with `/opt/meeting-system/venv/bin/python`. It uses the existing CTranslate2 libraries in `/opt/meeting-system/ct2/lib`, binds a free loopback port, and opens a private SSH forward. It changes no existing GX10 service. Stopping the supervisor closes the SSH session and stops this scratch transcription process. It uses the cached small model and downloads no model.

Use headphones in a noisy room. Energy VAD can mistake background noise or speaker echo for speech. GX10 and the selected model provider must be reachable. The page displays provider failures and allows another spoken turn. iPhone Safari and human listening quality still need manual acceptance.

## Verify Local

Run the unit tests from the repository root:

```sh
poc/voice-call/node_modules/node/bin/node --experimental-strip-types --test \
  poc/voice-call/local.test.ts poc/voice-call/round3.test.ts
```

With the isolated stack running, run the same Node executable with `--experimental-strip-types poc/voice-call/round3-smoke.ts`. It makes one text-injected AllTalk call, starts a read-only full-agent task, says "Hello?" during it, and waits for the spoken result. Evidence is `.data/round3-text.json`. Run `xvfb-run -a node_modules/.bin/electron --no-sandbox poc/voice-call/ui-smoke.cjs` for the actual HTTPS page, library previews, and a short tagged Turbo reply. This browser check spends ElevenLabs credits. Do not overlap calls.

For one matched timing sample, run:

```sh
~/ai/bin/gsd-secrets run --key ELEVENLABS_API_KEY -- \
  poc/voice-call/node_modules/node/bin/node --experimental-strip-types \
  poc/voice-call/tts-timing.ts 1
```

Invoke samples `2` and `3` separately. Each makes one short live Local reply, then replays its text cadence through the old per-sentence HTTP path. The script asserts nonzero audio on both paths and writes `.data/tts-sample-N.json`. First-token-to-audio measures server PCM receipt, not audible playback. See [RESULTS-round3.md](RESULTS-round3.md) for the observed timings, protocol evidence, credit usage, and remaining limits.

The earlier `local-smoke.ts` exercises AllTalk speech input and GX10 transcription. Its historical acceptance record is in [RESULTS-local.md](RESULTS-local.md). The new text-injected checks do not prove microphone recognition quality.

Read `.data/local-timings.json` for the phases, generated transcripts, replies, audio byte counts, and failures. Transcription measures the PoC request through the SSH forward to the decoded transcript. First reply token measures the 9router request to the first text token. First TTS audio measures the first sentence request to the first PCM chunk received by the server. EOS uses the server's last voiced PCM frame, so it includes the 500 ms VAD wait. These timestamps do not measure when sound reaches a person's ear. See [RESULTS-local.md](RESULTS-local.md) for the acceptance record.

## Run

The repository's source dependencies must be installed. The PoC has its own npm manifest and lockfile. Its start script installs its dependencies when missing and uses its local Node 24.

```sh
poc/voice-call/start.sh
```

The script takes a snapshot when none exists, starts a loopback development OpenMausBot server, opens a Cloudflare quick tunnel, and starts the PoC server. It prints the private HTTPS page URL, three ports and exact owned PIDs. Runtime files, credentials supplied in memory, copied context, audio and logs stay under ignored `.data/`. Never commit that directory or share its contents as public evidence.

`POC_BOTS` selects comma-separated bot names or IDs before the first snapshot. The measured bot is St. Paul. Its configured ElevenLabs voice is `JBFqnCBsd6RMkjVDRZzb`. The workspace default uses Fish and has an empty ElevenLabs voice, so the bot override is the comparison voice. The custom Agent and Speech Engine use Turbo and PCM at 16 kHz. Realtime Mini keeps the voice and PCM rate, but manages its TTS model.

`--snapshot` requests snapshot creation. Existing snapshots are protected against replacement. Use a fresh worktree for a new snapshot. This preserves the isolated bot's new conversation state.

Read `.data/run.json` for the current URL and PIDs. Stop only this supervisor with the exact `kill -TERM PID` printed at startup. It stops its own dev launcher, PoC server and tunnel. The dev launcher stops its server child. Do not kill processes by name.

The page has a bot picker, variant switch, buffer toggle, response model, thinking model and hosted-agent LLM. Round two adds Anthropic caching, full or slim context, a memory-selection topic, turn eagerness, silence timeout and speculative turns. The three ElevenLabs variants use the ElevenLabs browser client over WebRTC. Local uses its own PCM WebSocket. Open the printed HTTPS URL on iPhone Safari and grant microphone access. One call can run at a time.

## Earlier hosted comparisons

The following synchronous tool behavior belongs to the hosted comparison variants. Local uses the background path above.

Speech Engine attaches to the same HTTP server at `/ws` using `@elevenlabs/elevenlabs-js` 2.76.0. ElevenLabs authenticates the connection with its SDK JWT validation. The engine's WebSocket URL follows the current quick tunnel on every startup.

The response model receives the selected bot context and streams each text delta immediately. It answers small talk itself and has one `think(request)` tool. With the buffer enabled, the first chunk is `Okay... `, including the trailing space. Only that mode adds `Let me think through that... ` before waiting for a tool result. The round-two prompt requests silent tool calls and no acknowledgments. The log also records `substantiveTextAt` for the first model text or thinking result. This can still be a model-generated holding line, so the round-two report aligns the actual answer words to recorded audio.

The SDK allows `session.sendResponse` only during `onTranscript`. The thinking result therefore continues the same open async generator. The engine uses the documented maximum 15-second upstream cascade timeout. While thinking, it sends a whitespace chunk every five seconds so the open response continues to make progress. A new transcript aborts the old generator and thinking request. Cancellation also interrupts the copied bot's dev thread before releasing the thinking slot. Replacement requests wait for that cleanup through a promise queue. The prototype does not push a late result as another utterance. That SDK limit is part of the architecture comparison.

Agents uses one cached hosted agent, a selectable hosted LLM and one server webhook tool. A random shared-secret header protects the webhook. The server updates that secret on the remote tool at each startup. The hosted default is `gemini-3.1-flash-lite`. The prompt and LLM overrides are enabled in the agent's platform settings.

The browser client's WebRTC data packet limit is 64 KB. The full copied context exceeded it during the first browser check. For Agents, the server now uploads the full system prompt through the agent API immediately before issuing the conversation token. The small conversation override selects the LLM, and the dynamic variable supplies the call ID. This is safe for this experiment's single active call. Concurrent calls would need separate agents or another context-delivery design.

Thinking model `bot` runs the source OpenMausBot CLI against the isolated dev port, in the copied bot's existing thread. It uses the bot's configured Claude driver and `claude-opus-5-5` model. The request forbids external actions and old job resumption. Alternative thinking models receive the same copied context with no tools.

Every user transcript and spoken agent transcript is appended to `.data/logs/transcripts.jsonl`. Thinking requests and replies also enter the copied bot thread. Normal spoken small talk stays in the JSONL, which the task permits. The response context is rebuilt from the copied bot at each call start; ElevenLabs supplies the current call transcript on subsequent turns.

## Snapshot isolation

The live directory `/home/clauber/.openmausbot` is read only. No message goes to the live port 8799, and the live service is never restarted. `snapshot.ts` copies `config.json`, `bots.json`, selected `bots/<id>/` trees and `memory-journal/`. SQLite's `.backup` command copies the live message database safely while the service runs. It also copies the selected workspace's `MEMORY.md` and `memory/` Markdown. It skips symlinks.

The script neutralizes the copy before starting any server. `.data/omb/snapshot.json` records the actual keys removed. For the measured snapshot:

- The config allowlist retains profile, onboarding and the selected voice. It replaces instances with the configured local Claude CLI only. It removes `decider`, `customDomain`, `live`, `openaiCompat`, `browserEngine`, `threads`, `browserProfiles`, `masterChiefOfStaffBotId`, `masterChiefOfStaffRevision`, `memoryProvider` and `treg`.
- It sets `mcpServers` to an empty object and disables automatic recovery. It disables skill authoring/review, browser, shared computers, ambient Claude MCP and skills, generated thread titles, smart setup, automatic recall, skill library, room memory capture, parallel room jobs, chief escalation, agent tool bridge and saved steps.
- The bot allowlist retains identity, thread ID, SOUL fields, color, creation time, model selection and voice. It removes live `resumeCursors`, notifications, unread state, section, approval grants, Composio, peer communications grants, tasks, SOUL drift state, chief authority, always-allow rules, pins, profile request IDs, browser profile, browser connection, cloud backend, mascot state and team-setup receipts.
- The copied bot gets a new workspace under the snapshot, ask permissions, no automatic approval, no browser, no connector tools, no Composio, no MCP servers and no tasks. Its live teammate relationships are omitted.
- It clears `chat_followups`, `command_receipts` and `running_turns` in the copied database. It copies no runtime database, engine sessions, routines, schedules, waits, channels, webhooks, provider credential files, approvals, companion state, push state, backups, fleet state, OAuth files or environment files. Absent files cannot register those external integrations in the dev instance.
- The dev server gets its own HOME, Claude config directory, data directory and free loopback ports. The selected local Claude proxy path is reused as executable code. No live resume cursor is supplied. The first dev turn created a new Claude cursor and completed in the same copied thread.

The product runtime can still create its own local MausBot incident thread and retry a failed dev turn. This happened during the experiment. The `automaticRecovery` setting disables model fallback, not that incident mechanism. Its observed retry targeted the copied dev thread. Native CLI tools remain available, so the snapshot is not an operating-system or network sandbox.

The full response prompt reuses `botPersona` and `buildSystemPrompt` from the product read only. It includes the complete SOUL, current copied memory Markdown and the last 30 copied thread messages. The measured round-one initial context was 125,534 characters. The memory journal is copied for continuity but is not duplicated into the prompt because it contains historical revisions. Private context never enters tracked files.

Slim context preserves the complete identity and SOUL. Once at call start, it ranks memory paragraphs by keywords in the call topic, keeps up to 12 paragraphs and 12,000 characters, and adds the last 10 thread messages. This cheap selection can omit relevant facts. The `bot` thinking route still asks the copied bot's own full agent for memory and tools.

Anthropic cache mode puts identity, SOUL and voice instructions in the first stable system block, memory in the second, and recent thread in the final uncached block. Both stable blocks have `cache_control` breakpoints. Call setup prewarms the identical model, tools and system prefix before joining. Turn logs include total input tokens, cache reads and cache creation. Prewarming affects call setup time and is outside the measured EOS interval. Response-model thinking is disabled for Anthropic and Gemini. Compatible providers retain their model defaults.

ElevenLabs Realtime Mini was the third variant in the earlier comparison. It remains selectable, but current startup skips its billable service probe. It gets full context, the same configured ElevenLabs voice and the same think webhook. Select it with `conversation_config.realtime_model = eleven_realtime_v1_mini`. ElevenLabs manages its component models, reasoning and TTS settings. Its documentation describes a cascaded architecture, so the Realtime name does not establish a fused speech-to-speech model. OpenAI Realtime was probed separately and could not generate with the available credit balance. No Azure Live credentials were configured. See the round-two results for exact statuses.

## Model discovery

`gsd-secrets run` supplies ElevenLabs, Anthropic, OpenAI, Gemini, Groq, 9router and DeepSeek keys in memory. The server also reads configured provider-key presence in live config without printing values or changing the file. The snapshot deliberately removes provider credentials. The original config had a 9router key in `openaiCompat`; Cerebras, Groq, Mistral, DeepSeek, XAI and OpenRouter sections had no configured key.

Startup fetches each configured compatible gateway's model catalog once, selects fast candidates, and makes a streaming one-word completion probe. Only models that return text enter the response and thinking pickers. Anthropic, Groq and 9router provide three distinct working routes. Hosted LLM choices answered signed-WebSocket text probes in the earlier comparison. Current startup skips those billable probes. Probe evidence is in `.data/model-discovery.json`, `.data/model-probes.json` and `.data/hosted-probes.json`.

Working response models were `claude-haiku-5-5`, Groq `openai/gpt-oss-120b`, 9router `gx10/claude-haiku-5-5`, and 9router `glm/glm-5.3-flash`. Groq passes a short probe but cannot accept this bot's full context at its current token limit. It remains available for explicit failure comparison; the complete matrix uses Haiku and 9router GLM Flash. Both 9router models also answered full-context probes. Hosted `gemini-3.1-flash-lite`, `gpt-4.1-mini` and `claude-haiku-5-5` all answered probes.

Failed probes are observations, not launch blockers:

| Route | Model or group | HTTP status | Observed reason |
|---|---|---:|---|
| Direct OpenAI | gpt-4.1-mini, gpt-5.4-mini | 429 | Credit balance exhausted |
| Direct OpenAI, earlier discovery | gpt-4.1-nano | 404 | Deprecated model |
| Direct Gemini | gemini-2.5-flash | 403 | Billing unavailable for this project |
| Direct DeepSeek | deepseek-flash | 402 | Insufficient balance |
| Groq, full-context call | openai/gpt-oss-120b | 413 | 8,000 TPM limit; full prompt requested about 33,000 tokens |
| 9router ci | GPT mini/nano, Gemini flash/lite, Haiku | 503 | Upstream 402 insufficient balance |
| 9router ds | deepseek-v4.1-flash | 503 | Upstream 402 insufficient balance |
| 9router cc, earlier discovery | Haiku | 503 | Upstream 401 expired OAuth |
| 9router ag, earlier discovery | Gemini | 503 | Upstream 403 |
| 9router, earlier discovery | Unprefixed GLM | 404 | No route credentials |

Azure discovery was optional and was skipped. No account or billing change was requested.

## Measure

```sh
~/ai/bin/gsd-secrets run --key ELEVENLABS_API_KEY -- \
  poc/voice-call/node_modules/node/bin/node \
  --experimental-strip-types poc/voice-call/scripted-calls.ts

poc/voice-call/node_modules/node/bin/node \
  --experimental-strip-types poc/voice-call/report.ts
```

`--smoke` runs hello against one engine setting and the hosted agent. `POC_SCENARIO=memory` selects one scenario for diagnosis. `POC_MODELS` can select two comma-separated reachable response model IDs. The full run alternates five settings within each of five scenarios. The engine matrix is buffer off/on with Haiku and 9router GLM Flash, always thinking through the bot. The hosted agent uses its default LLM. The scenarios are hello/small talk, memory, a read-only local tool request, interruption, and a conversation lasting at least 180 seconds.

The scripted caller synthesizes user speech with ElevenLabs, caches PCM locally, streams 100 ms audio frames in real time and sends silence during pauses. It uses the signed conversation WebSocket transport because headless WebRTC microphone injection is awkward. The separate browser check exercises the actual tunnel page and WebRTC with a fake microphone backed by synthesized PCM.

`.data/logs/calls.jsonl` holds event snapshots keyed by call and turn. It records settings, EOS timestamp and source, first text, substantive text, first audio, thinking duration, interruptions and errors. The scripted caller posts speech-begin before PCM and speech-end after PCM. Every transcript generation gets a separate timing row, including replacements for generations that produced no text. Replacement generations use server transcript arrival as their EOS proxy. Browser timing uses VAD falling edge when available, otherwise transcript arrival. Hosted first text is client receipt because the hosted LLM has no server-send timestamp exposed here.

The report merges snapshots per turn, excludes failed/interrupted turns from latency percentiles and excludes missing or negative intervals. It prints median and nearest-rank p90. It groups different signal sources separately. The interruption count includes cancelled speculative generations as well as user interruptions. WebSocket audio arrival and browser speaking mode are playback proxies. They do not prove the time sound reached a human's ear. The instant buffer also does not prove that the substantive answer arrived quickly.

See [RESULTS.md](RESULTS.md) for measured output and acceptance evidence. The host was busy during this experiment, with a load average around 48 on 24 cores before the final run. Settings alternate to reduce time drift. These observations support architecture exploration, not a production performance guarantee.

## Repeat round two

```sh
~/ai/bin/gsd-secrets run --key ELEVENLABS_API_KEY -- \
  env POC_RUN_TAG=matrix-final \
  poc/voice-call/node_modules/node/bin/node --experimental-strip-types \
  poc/voice-call/scripted-calls.ts --round2

~/ai/bin/gsd-secrets run --key ELEVENLABS_API_KEY -- \
  env POC_RUN_TAG=matrix-final \
  poc/voice-call/node_modules/node/bin/node --experimental-strip-types \
  poc/voice-call/round2-report.ts --fetch-metrics --align
```

The round-two matrix interleaves settings in alternating order. Each setting gets four two-turn small-talk calls and five one-turn memory calls. `POC_SETTINGS` filters comma-separated setting labels. `POC_SCENARIO=interrupt` or `tool` runs those scenarios once per selected setting. Use a separate `POC_RUN_TAG` to keep those observations separate.

`round2-report.ts` joins scripted utterances to final server generations, retains cancelled attempts in raw logs, fetches actual producing models and vendor phase durations, and aligns recorded PCM with final transcripts. It maps the first answer word to the chunk's arrival timestamp. `.data/round2-answer-offsets.json` can hold reviewed preamble word counts keyed by `callId/sequence`. Alignment that places a memory answer before think completion requires review. Counts refer to nonempty alignment word entries. A count beyond the transcript rejects a response with no answer. Inspect transcripts before treating these marks as answers. Forced alignment is an estimate, not human listening acceptance.

See [RESULTS-round2.md](RESULTS-round2.md) for comparisons and phase limits. The raw turn phases are EOS, transcript arrival, LLM request, first token, first text and first audio. Hosted internal timestamps are unavailable; vendor phase durations are reported separately. Silence timeout controls taking a turn after prolonged silence. It is not a fixed end-of-speech delay. Turn eagerness and speculative generation affect earlier turn detection.

## References

- [Speech Engine overview](https://elevenlabs.io/docs/overview/capabilities/speech-engine.md).
- [Speech Engine cookbook](https://elevenlabs.io/docs/eleven-api/guides/cookbooks/speech-engine.md).
- [JavaScript Speech Engine SDK](https://elevenlabs.io/docs/eleven-api/resources/libraries/speech-engine/javascript-sdk-reference.md).
- [Conversation flow](https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow.md).
- [Realtime models](https://elevenlabs.io/docs/eleven-agents/customization/realtime-models.md).
- [Realtime API compatibility](https://elevenlabs.io/docs/eleven-agents/guides/openai-realtime-compatibility.md).
- [Repository verification](../../docs/verification/README.md).

The source SDK docs and dependency types were checked for the installed versions. The repository's isolated fake-engine CLI verification also passed. A standalone TypeScript check of the server's imports reports diagnostics in untouched product files under the PoC's compiler settings. No diagnostic points into this PoC. This is not a clean repository typecheck. This prototype is disposable and is not a product implementation.
