# Voice-call architecture experiment

Clauber wants a phone call to feel like talking to the bot he already chats with, with the same identity, memory, thread and voice. This throwaway prototype compares ElevenLabs Agents with ElevenLabs Speech Engine. It changes no product code.

## Run

The repository's source dependencies must be installed. The PoC has its own npm manifest and lockfile. Its start script installs its dependencies when missing and uses its local Node 24.

```sh
poc/voice-call/start.sh
```

The script takes a snapshot when none exists, starts a loopback development OpenMausBot server, opens a Cloudflare quick tunnel, and starts the PoC server. It prints the private HTTPS page URL, three ports and exact owned PIDs. Runtime files, credentials supplied in memory, copied context, audio and logs stay under ignored `.data/`. Never commit that directory or share its contents as public evidence.

`POC_BOTS` selects comma-separated bot names or IDs before the first snapshot. The measured bot is St. Paul. Its configured ElevenLabs voice is `JBFqnCBsd6RMkjVDRZzb`. The workspace default uses Fish and has an empty ElevenLabs voice, so the bot override is the correct comparison voice. Both variants use ElevenLabs Flash v2 and PCM at 16 kHz.

`--snapshot` requests snapshot creation. Existing snapshots are protected against replacement. Use a fresh worktree for a new snapshot. This preserves the isolated bot's new conversation state.

Read `.data/run.json` for the current URL and PIDs. Stop only this supervisor with the exact `kill -TERM PID` printed at startup. It stops its own dev launcher, PoC server and tunnel. The dev launcher stops its server child. Do not kill processes by name.

The page has a bot picker, variant switch, buffer toggle, response model, thinking model and hosted-agent LLM. Call and Hang up use the ElevenLabs browser client over WebRTC. Open the printed HTTPS URL on iPhone Safari and grant microphone access. One call can run at a time.

## Compared paths

Speech Engine attaches to the same HTTP server at `/ws` using `@elevenlabs/elevenlabs-js` 2.76.0. ElevenLabs authenticates the connection with its SDK JWT validation. The engine's WebSocket URL follows the current quick tunnel on every startup.

The response model receives the bot's full context and streams text. It answers small talk itself and has one `think(request)` tool. With the buffer enabled, the first chunk is `Okay... `, including the trailing space. A tool call streams `Let me think through that... ` before waiting for the result. The log also records `substantiveTextAt` for the first model text or thinking result. This can still be a model-generated holding line.

The SDK allows `session.sendResponse` only during `onTranscript`. The thinking result therefore continues the same open async generator. The engine uses the documented maximum 15-second upstream cascade timeout. While thinking, it sends a whitespace chunk every five seconds so the open response continues to make progress. A new transcript aborts the old generator and thinking request. Cancellation also interrupts the copied bot's dev thread before releasing the thinking slot. The prototype does not push a late result as another utterance. That SDK limit is part of the architecture comparison.

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

The response prompt reuses `botPersona` and `buildSystemPrompt` from the product read only. It includes the complete SOUL, current copied memory Markdown and the last 30 copied thread messages. The measured initial context was 125,534 characters. The memory journal is copied for continuity but is not duplicated into the prompt because it contains historical revisions. Private context never enters tracked files.

## Model discovery

`gsd-secrets run` supplies ElevenLabs, Anthropic, OpenAI, Gemini, Groq, 9router and DeepSeek keys in memory. The server also reads configured provider-key presence in live config without printing values or changing the file. The snapshot deliberately removes provider credentials. The original config had a 9router key in `openaiCompat`; Cerebras, Groq, Mistral, DeepSeek, XAI and OpenRouter sections had no configured key.

Startup fetches each configured compatible gateway's model catalog once, selects fast candidates, and makes a streaming one-word completion probe. Only models that return text enter the response and thinking pickers. Anthropic, Groq and 9router provide three distinct working routes. Hosted LLM choices each answer a real signed-WebSocket text probe at startup. Probe evidence is in `.data/model-discovery.json`, `.data/model-probes.json` and `.data/hosted-probes.json`.

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

## References

- [Speech Engine overview](https://elevenlabs.io/docs/overview/capabilities/speech-engine.md).
- [Speech Engine cookbook](https://elevenlabs.io/docs/eleven-api/guides/cookbooks/speech-engine.md).
- [JavaScript Speech Engine SDK](https://elevenlabs.io/docs/eleven-api/resources/libraries/speech-engine/javascript-sdk-reference.md).
- [Repository verification](../../docs/verification/README.md).

The source SDK docs and dependency types were checked for the installed versions. The repository's isolated fake-engine CLI verification also passed. A standalone TypeScript check of the server's imports reports diagnostics in untouched product files under the PoC's compiler settings. No diagnostic points into this PoC. This is not a clean repository typecheck. This prototype is disposable and is not a product implementation.
