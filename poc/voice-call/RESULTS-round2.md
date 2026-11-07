# Voice-call round-two results

Clauber wants a call to feel like talking to the same bot he chats with. This throwaway PoC measures the wait for an actual answer, with acknowledgments excluded.

There is no winner under the required spread rule. Realtime Mini has the lowest observed small-talk median, 632 ms versus 1,489 ms for full-context Haiku. Their observed ranges overlap. Memory answers still take roughly 12 to 16 seconds because the full bot agent dominates the wait.

## Compared settings

All settings disable the explicit buffer and use eager turn-taking. The baseline reruns the round-one Haiku model with full context and no cache. Every setting shares the round-two silent-tool instruction. Normal and patient eagerness are selectable but were not benchmarked. Silence timeout is 30 seconds, except slim-spec uses 7 seconds and speculative generation. Timeout is a prolonged-silence control, not a fixed end-of-speech wait.

| Setting | Response path | Context | Cache | Speculative |
|---|---|---|---|---|
| baseline | claude-haiku-5-5 | Full | Off | Off |
| cache-full | claude-haiku-5-5 | Full | On | Off |
| slim | claude-haiku-5-5 | Slim | Off | Off |
| slim-cache | claude-haiku-5-5 | Slim | On | Off |
| slim-spec | claude-haiku-5-5 | Slim | On | On |
| agent | gemini-3.1-flash-lite | Full | Off | Off |
| realtime | eleven_realtime_v1_mini | Full | Off | Off |

The final run contains 63 calls and 91 scripted turns. Every setting has four two-turn small-talk calls and five one-turn memory calls. Order alternates between forward and reverse on successive repetitions. All 63 calls passed transport, reply-presence and required-thinking checks. Four Gemini small-talk responses did not answer the question. Those remain answer failures, with no real-answer mark.

## End of speech to first real answer audio

Values are milliseconds. Each cell gives median / nearest-rank p90, then the observed range. With fewer than ten observations, this p90 is the maximum. These are descriptive ranges, not confidence intervals. The first-audio column preserves the round-one scripted_pcm_end to websocket_audio_arrival_proxy signal. It can time a preamble. The real-answer column uses reviewed word alignment and the arrival of the PCM chunk containing the first answer word.

| Setting | Scenario | Attempted turns | First audio, median / p90; range; n | Real answer, median / p90; range; n | Largest measured wait |
|---|---|---:|---|---|---|
| Haiku full baseline | hello | 8 | 1489 / 1873; 957 to 1873; n=8 | 1489 / 1873; 957 to 1873; n=8 | Model request to first token, then audio path |
| Haiku full baseline | memory | 5 | 6856 / 7285; 6836 to 7285; n=5 | 12728 / 13650; 9784 to 13650; n=5 | Full bot agent |
| Haiku full, cache | hello | 8 | 1320 / 1750; 1027 to 1750; n=8 | 1320 / 1750; 1027 to 1750; n=8 | Model request to first token, then audio path |
| Haiku full, cache | memory | 5 | 6660 / 6874; 6474 to 6874; n=5 | 12453 / 17007; 11172 to 17007; n=5 | Full bot agent |
| Haiku slim | hello | 8 | 1194 / 1404; 983 to 1404; n=8 | 1194 / 1404; 983 to 1404; n=8 | Model request to first token, then audio path |
| Haiku slim | memory | 5 | 6400 / 6674; 6304 to 6674; n=5 | 14035 / 15886; 10955 to 15886; n=5 | Full bot agent |
| Haiku slim, cache | hello | 8 | 1196 / 1405; 1061 to 1405; n=8 | 1196 / 1405; 1061 to 1405; n=8 | Model request to first token, then audio path |
| Haiku slim, cache | memory | 5 | 6421 / 6595; 6318 to 6595; n=5 | 14786 / 15730; 12966 to 15730; n=5 | Full bot agent |
| Haiku slim, cache, speculative | hello | 8 | 1198 / 1408; 995 to 1408; n=8 | 1198 / 1408; 995 to 1408; n=8 | Model request to first token, then audio path |
| Haiku slim, cache, speculative | memory | 5 | 6544 / 6610; 6311 to 6610; n=5 | 15555 / 17796; 12460 to 17796; n=5 | Full bot agent |
| Hosted Gemini full | hello | 8 | 12758 / 31729; 9122 to 31729; n=8 | 11445 / 31729; 9122 to 31729; n=4 | Full bot agent |
| Hosted Gemini full | memory | 5 | 15226 / 15669; 12186 to 15669; n=5 | 15226 / 15669; 12186 to 15669; n=5 | Full bot agent |
| Realtime Mini full | hello | 8 | 512 / 880; 231 to 880; n=8 | 632 / 1016; 270 to 1016; n=8 | Provider model startup and audio path |
| Realtime Mini full | memory | 5 | 12235 / 13882; 11731 to 13882; n=5 | 12271 / 13927; 11767 to 13927; n=5 | Full bot agent |

Caching and slim context have lower small-talk medians than the baseline, but every range overlaps. Cache and speculative generation do not separate the slim variants. Realtime Mini is the most promising next trial, not an established performance winner. The conservative tag exclusion moves its median from the 513 ms first-audio proxy to 632 ms for the real-answer mark.

The hosted Gemini result is not comparable to round one as a pure model-speed regression. It unnecessarily called think during small talk. Four of eight replies also blamed microphone echo despite correct user transcripts. Final provider records name Gemini for all these calls. Earlier smoke calls that fell back to GPT-4o are excluded from this matrix.

## Context and cache evidence

Input tokens include uncached input, cache reads and cache creation. These are the provider token counts, not estimates from characters. Different providers tokenize the same text differently. The copied memory and thread evolved during earlier experiments and this matrix. Full Haiku context is now about 56K to 62K input tokens, above the approximately 33K in round one. These calls are paired configuration observations, not independent recall trials.

| Setting | Scenario | Total input, median / p90; range; n | Cache read, median / p90; range; n | Cache creation on measured turn, median / p90; range; n |
|---|---|---|---|---|
| baseline | hello | 57812 / 60134; 55750 to 60134; n=8 | 0 / 0; 0 to 0; n=8 | 0 / 0; 0 to 0; n=8 |
| baseline | memory | 58748 / 61473; 55883 to 61473; n=5 | 0 / 0; 0 to 0; n=5 | 0 / 0; 0 to 0; n=5 |
| cache-full | hello | 57809 / 60140; 55750 to 60140; n=8 | 53176 / 55094; 51231 to 55094; n=8 | 0 / 0; 0 to 0; n=8 |
| cache-full | memory | 58596 / 61672; 56014 to 61672; n=5 | 54067 / 56307; 51559 to 56307; n=5 | 0 / 0; 0 to 0; n=5 |
| slim | hello | 8762 / 8973; 8519 to 8973; n=8 | 0 / 0; 0 to 0; n=8 | 0 / 0; 0 to 0; n=8 |
| slim | memory | 8869 / 9093; 8780 to 9093; n=5 | 0 / 0; 0 to 0; n=5 | 0 / 0; 0 to 0; n=5 |
| slim-cache | hello | 8762 / 8973; 8519 to 8973; n=8 | 7220 / 7220; 7220 to 7220; n=8 | 0 / 0; 0 to 0; n=8 |
| slim-cache | memory | 9023 / 9067; 8838 to 9067; n=5 | 7220 / 7220; 7220 to 7220; n=5 | 0 / 0; 0 to 0; n=5 |
| slim-spec | hello | 8764 / 8973; 8519 to 8973; n=8 | 7220 / 7220; 7220 to 7220; n=8 | 0 / 0; 0 to 0; n=8 |
| slim-spec | memory | 9106 / 9316; 8804 to 9316; n=5 | 7220 / 7220; 7220 to 7220; n=5 | 0 / 0; 0 to 0; n=5 |
| agent | hello | 42898 / 44553; 41557 to 44553; n=8 | Unavailable | Unavailable |
| agent | memory | 44065 / 45968; 42103 to 45968; n=5 | Unavailable | Unavailable |
| realtime | hello | 42323 / 44020; 41116 to 44020; n=8 | Unavailable | Unavailable |
| realtime | memory | 43819 / 45687; 41727 to 45687; n=5 | Unavailable | Unavailable |

All 27 cached calls prewarmed before joining. The measured prewarm model round trip had median 710 ms, p90 1146 ms and range 595 to 1338 ms. It is outside EOS timing and is not the complete call-setup duration.

The stable prefix places identity, complete SOUL and voice instructions first, then memory, with Anthropic cache breakpoints on both blocks. Recent thread and current conversation are last. Cache reads prove that the measured turns reused the prefix. Slim preserves the identical identity and 1,973-character SOUL, selects at most twelve memory paragraphs and 12,000 characters once per call, and includes ten recent thread messages. The real think tool still uses the copied bot's full native agent. Keyword selection can omit relevant facts.

## Phase limits

The small-talk Haiku request-to-token median drops from 848 ms to 606 ms with slim context. Text forwarding has a 0 ms median at millisecond clock resolution. The remaining text-to-audio path is about 500 ms. Provider TTS time to first byte is about 116 to 119 ms, so the entire audio path cannot be called TTS compute. It also contains upstream text buffering, transport and audio delivery.

For Realtime Mini, vendor model time to first byte has a 329 ms median and vendor TTS has a 67 ms median on small talk. Turn silence has a 288 ms median. These provider durations use different internal clocks and can overlap. They do not sum to the client EOS interval. Hosted transcript receipt can also follow already-streamed audio.

Every memory setting spends most of its time inside the copied full bot agent. Engine replacement generations also wait for cancellation cleanup, typically hundreds of milliseconds to about a second. Faster response-model startup cannot halve a turn dominated by a roughly ten-second native agent request. The native CLI returns a complete reply, so this PoC does not stream partial native-agent output.

The response adapter yields every model text delta. The installed Speech Engine SDK forwards each yielded chunk. There is no whole-sentence accumulator in this code. ElevenLabs documents its own wait for sufficient text and punctuation. Engine memory preamble audio often arrives about five seconds after first text, near the whitespace keepalive. That is an audio-path observation, not a measured five-second TTS computation. Preamble audio is excluded from the answer mark. Anthropic response thinking is disabled. Gemini thinking budget is zero. Compatible routes retain provider defaults, and Realtime Mini manages its own components.

The following table retains n, median, p90 and range for each observed phase. Missing internal hosted timestamps stay unavailable. A memory text-to-audio interval can end at preamble audio. The separate think-to-real-audio phase ends at the answer. All values are milliseconds.

| Setting | Scenario | Phase | Median / p90; range; n |
|---|---|---|---|
| baseline | hello | eosToTranscript | 111 / 174; -108 to 174; n=8 |
| baseline | hello | transcriptToRequest | 0 / 1; 0 to 1; n=8 |
| baseline | hello | requestToToken | 848 / 1191; 600 to 1191; n=8 |
| baseline | hello | tokenToText | 0 / 1; 0 to 1; n=8 |
| baseline | hello | textToAudio | 521 / 563; 352 to 563; n=8 |
| baseline | hello | vendor llmTtfb | 910 / 1257; 659 to 1257; n=8 |
| baseline | hello | vendor ttsTtfb | 116 / 130; 97 to 130; n=8 |
| baseline | hello | vendor turnSilence | 224 / 288; 160 to 288; n=8 |
| baseline | hello | vendor asr | 30 / 47; 17 to 47; n=8 |
| baseline | hello | vendor audioSinceSilence | 1659 / 1922; 1212 to 1922; n=8 |
| baseline | memory | eosToTranscript | 135 / 162; 89 to 162; n=5 |
| baseline | memory | transcriptToRequest | 0 / 1; 0 to 1; n=5 |
| baseline | memory | requestToToken | 1064 / 1397; 936 to 1397; n=5 |
| baseline | memory | tokenToText | 0 / 1; 0 to 1; n=5 |
| baseline | memory | textToAudio | 5722 / 5783; 5674 to 5783; n=5 |
| baseline | memory | thinkToRealAudio | 342 / 370; 332 to 370; n=5 |
| baseline | memory | thinkQueue | 141 / 891; 0 to 891; n=5 |
| baseline | memory | thinkAgent | 10152 / 11139; 7819 to 11139; n=5 |
| baseline | memory | think | 10317 / 11689; 7819 to 11689; n=5 |
| baseline | memory | vendor llmTtfb | 1124 / 1462; 995 to 1462; n=5 |
| baseline | memory | vendor ttsTtfb | 115 / 127; 110 to 127; n=5 |
| baseline | memory | vendor turnSilence | 320 / 320; 256 to 320; n=5 |
| baseline | memory | vendor asr | 21 / 46; 17 to 46; n=5 |
| baseline | memory | vendor audioSinceSilence | 7072 / 7387; 6925 to 7387; n=5 |
| cache-full | hello | eosToTranscript | 114 / 192; -99 to 192; n=8 |
| cache-full | hello | transcriptToRequest | 0 / 0; 0 to 0; n=8 |
| cache-full | hello | requestToToken | 678 / 1097; 637 to 1097; n=8 |
| cache-full | hello | tokenToText | 0 / 0; 0 to 0; n=8 |
| cache-full | hello | textToAudio | 507 / 564; 460 to 564; n=8 |
| cache-full | hello | vendor llmTtfb | 737 / 1156; 699 to 1156; n=8 |
| cache-full | hello | vendor ttsTtfb | 116 / 123; 104 to 123; n=8 |
| cache-full | hello | vendor turnSilence | 272 / 288; 160 to 288; n=8 |
| cache-full | hello | vendor asr | 24 / 74; 16 to 74; n=8 |
| cache-full | hello | vendor audioSinceSilence | 1459 / 1908; 1322 to 1908; n=8 |
| cache-full | memory | eosToTranscript | 141 / 163; 102 to 163; n=5 |
| cache-full | memory | transcriptToRequest | 0 / 1; 0 to 1; n=5 |
| cache-full | memory | requestToToken | 720 / 955; 599 to 955; n=5 |
| cache-full | memory | tokenToText | 0 / 0; 0 to 0; n=5 |
| cache-full | memory | textToAudio | 5746 / 5905; 5705 to 5905; n=5 |
| cache-full | memory | thinkToRealAudio | 352 / 370; 345 to 370; n=5 |
| cache-full | memory | thinkQueue | 835 / 1348; 647 to 1348; n=5 |
| cache-full | memory | thinkAgent | 9833 / 13963; 8186 to 13963; n=5 |
| cache-full | memory | think | 10480 / 15256; 9534 to 15256; n=5 |
| cache-full | memory | vendor llmTtfb | 785 / 1048; 663 to 1048; n=5 |
| cache-full | memory | vendor ttsTtfb | 115 / 132; 107 to 132; n=5 |
| cache-full | memory | vendor turnSilence | 320 / 320; 256 to 320; n=5 |
| cache-full | memory | vendor asr | 21 / 51; 17 to 51; n=5 |
| cache-full | memory | vendor audioSinceSilence | 6809 / 7022; 6650 to 7022; n=5 |
| slim | hello | eosToTranscript | 108 / 186; -113 to 186; n=8 |
| slim | hello | transcriptToRequest | 0 / 0; 0 to 0; n=8 |
| slim | hello | requestToToken | 606 / 698; 572 to 698; n=8 |
| slim | hello | tokenToText | 0 / 1; 0 to 1; n=8 |
| slim | hello | textToAudio | 502 / 626; 318 to 626; n=8 |
| slim | hello | vendor llmTtfb | 667 / 759; 633 to 759; n=8 |
| slim | hello | vendor ttsTtfb | 118 / 128; 101 to 128; n=8 |
| slim | hello | vendor turnSilence | 272 / 288; 160 to 288; n=8 |
| slim | hello | vendor asr | 17 / 34; 16 to 34; n=8 |
| slim | hello | vendor audioSinceSilence | 1336 / 1473; 1193 to 1473; n=8 |
| slim | memory | eosToTranscript | 136 / 166; 106 to 166; n=5 |
| slim | memory | transcriptToRequest | 0 / 0; 0 to 0; n=5 |
| slim | memory | requestToToken | 552 / 610; 521 to 610; n=5 |
| slim | memory | tokenToText | 0 / 1; 0 to 1; n=5 |
| slim | memory | textToAudio | 5712 / 5967; 5646 to 5967; n=5 |
| slim | memory | thinkToRealAudio | 353 / 375; 339 to 375; n=5 |
| slim | memory | thinkQueue | 1075 / 1752; 842 to 1752; n=5 |
| slim | memory | thinkAgent | 11543 / 13345; 8604 to 13345; n=5 |
| slim | memory | think | 12618 / 14346; 9446 to 14346; n=5 |
| slim | memory | vendor llmTtfb | 613 / 671; 583 to 671; n=5 |
| slim | memory | vendor ttsTtfb | 121 / 136; 106 to 136; n=5 |
| slim | memory | vendor turnSilence | 320 / 320; 256 to 320; n=5 |
| slim | memory | vendor asr | 25 / 67; 17 to 67; n=5 |
| slim | memory | vendor audioSinceSilence | 6582 / 6864; 6472 to 6864; n=5 |
| slim-cache | hello | eosToTranscript | 100 / 217; -15 to 217; n=8 |
| slim-cache | hello | transcriptToRequest | 0 / 1; 0 to 1; n=8 |
| slim-cache | hello | requestToToken | 584 / 653; 486 to 653; n=8 |
| slim-cache | hello | tokenToText | 0 / 9; 0 to 9; n=8 |
| slim-cache | hello | textToAudio | 498 / 572; 487 to 572; n=8 |
| slim-cache | hello | vendor llmTtfb | 644 / 712; 546 to 712; n=8 |
| slim-cache | hello | vendor ttsTtfb | 119 / 126; 109 to 126; n=8 |
| slim-cache | hello | vendor turnSilence | 272 / 288; 192 to 288; n=8 |
| slim-cache | hello | vendor asr | 37 / 49; 17 to 49; n=8 |
| slim-cache | hello | vendor audioSinceSilence | 1331 / 1536; 1231 to 1536; n=8 |
| slim-cache | memory | eosToTranscript | 152 / 157; 100 to 157; n=5 |
| slim-cache | memory | transcriptToRequest | 1 / 1; 0 to 1; n=5 |
| slim-cache | memory | requestToToken | 529 / 688; 466 to 688; n=5 |
| slim-cache | memory | tokenToText | 0 / 0; 0 to 0; n=5 |
| slim-cache | memory | textToAudio | 5743 / 5757; 5717 to 5757; n=5 |
| slim-cache | memory | thinkToRealAudio | 349 / 378; 331 to 378; n=5 |
| slim-cache | memory | thinkQueue | 1314 / 1406; 626 to 1406; n=5 |
| slim-cache | memory | thinkAgent | 12016 / 12803; 10608 to 12803; n=5 |
| slim-cache | memory | think | 13344 / 14200; 11264 to 14200; n=5 |
| slim-cache | memory | vendor llmTtfb | 591 / 758; 533 to 758; n=5 |
| slim-cache | memory | vendor ttsTtfb | 118 / 124; 111 to 124; n=5 |
| slim-cache | memory | vendor turnSilence | 320 / 320; 256 to 320; n=5 |
| slim-cache | memory | vendor asr | 25 / 56; 17 to 56; n=5 |
| slim-cache | memory | vendor audioSinceSilence | 6575 / 6787; 6496 to 6787; n=5 |
| slim-spec | hello | eosToTranscript | 118 / 207; -101 to 207; n=8 |
| slim-spec | hello | transcriptToRequest | 0 / 1; 0 to 1; n=8 |
| slim-spec | hello | requestToToken | 564 / 667; 487 to 667; n=8 |
| slim-spec | hello | tokenToText | 0 / 1; 0 to 1; n=8 |
| slim-spec | hello | textToAudio | 571 / 622; 513 to 622; n=8 |
| slim-spec | hello | vendor llmTtfb | 626 / 729; 549 to 729; n=8 |
| slim-spec | hello | vendor ttsTtfb | 119 / 134; 111 to 134; n=8 |
| slim-spec | hello | vendor turnSilence | 256 / 288; 160 to 288; n=8 |
| slim-spec | hello | vendor asr | 36 / 53; 17 to 53; n=8 |
| slim-spec | hello | vendor audioSinceSilence | 1333 / 1585; 1250 to 1585; n=8 |
| slim-spec | memory | eosToTranscript | 164 / 175; 117 to 175; n=5 |
| slim-spec | memory | transcriptToRequest | 0 / 0; 0 to 0; n=5 |
| slim-spec | memory | requestToToken | 587 / 661; 481 to 661; n=5 |
| slim-spec | memory | tokenToText | 0 / 1; 0 to 1; n=5 |
| slim-spec | memory | textToAudio | 5761 / 5827; 5713 to 5827; n=5 |
| slim-spec | memory | thinkToRealAudio | 338 / 572; 322 to 572; n=5 |
| slim-spec | memory | thinkQueue | 895 / 1633; 650 to 1633; n=5 |
| slim-spec | memory | thinkAgent | 12628 / 14947; 10411 to 14947; n=5 |
| slim-spec | memory | think | 13929 / 15842; 11061 to 15842; n=5 |
| slim-spec | memory | vendor llmTtfb | 661 / 776; 544 to 776; n=5 |
| slim-spec | memory | vendor ttsTtfb | 112 / 124; 109 to 124; n=5 |
| slim-spec | memory | vendor turnSilence | 320 / 320; 256 to 320; n=5 |
| slim-spec | memory | vendor asr | 22 / 63; 17 to 63; n=5 |
| slim-spec | memory | vendor audioSinceSilence | 6664 / 6781; 6412 to 6781; n=5 |
| agent | hello | eosToTranscript | 1053 / 1194; 699 to 1194; n=8 |
| agent | hello | textToAudio | 271 / 294; 235 to 294; n=8 |
| agent | hello | thinkToAudio | 961 / 1329; 872 to 1329; n=8 |
| agent | hello | thinkToRealAudio | 961 / 1329; 940 to 1329; n=4 |
| agent | hello | thinkQueue | 0 / 1; 0 to 1; n=8 |
| agent | hello | thinkAgent | 10356 / 29741; 7088 to 29741; n=8 |
| agent | hello | think | 10357 / 29741; 7088 to 29741; n=8 |
| agent | hello | vendor llmTtfb | 868 / 1078; 543 to 1086; n=16 |
| agent | hello | vendor ttsTtfb | 121 / 129; 109 to 129; n=8 |
| agent | hello | vendor turnSilence | 288 / 288; 160 to 288; n=8 |
| agent | hello | vendor audioSinceSilence | 12903 / 32033; 9419 to 32033; n=8 |
| agent | memory | eosToTranscript | 1261 / 1772; 1168 to 1772; n=5 |
| agent | memory | textToAudio | 295 / 353; 289 to 353; n=5 |
| agent | memory | thinkToAudio | 1096 / 1308; 932 to 1308; n=5 |
| agent | memory | thinkToRealAudio | 1096 / 1308; 932 to 1308; n=5 |
| agent | memory | thinkQueue | 0 / 1; 0 to 1; n=5 |
| agent | memory | thinkAgent | 12578 / 12897; 9791 to 12897; n=5 |
| agent | memory | think | 12579 / 12897; 9791 to 12897; n=5 |
| agent | memory | vendor llmTtfb | 989 / 1128; 568 to 1652; n=10 |
| agent | memory | vendor ttsTtfb | 129 / 140; 122 to 140; n=5 |
| agent | memory | vendor turnSilence | 320 / 320; 256 to 320; n=5 |
| agent | memory | vendor audioSinceSilence | 15346 / 15808; 12400 to 15808; n=5 |
| realtime | hello | eosToTranscript | 511 / 873; 228 to 873; n=8 |
| realtime | hello | vendor llmTtfb | 329 / 670; 239 to 670; n=8 |
| realtime | hello | vendor ttsTtfb | 67 / 72; 63 to 72; n=8 |
| realtime | hello | vendor turnSilence | 288 / 288; 160 to 288; n=8 |
| realtime | hello | vendor asr | 20 / 35; 17 to 35; n=8 |
| realtime | hello | vendor audioSinceSilence | 728 / 1087; 528 to 1087; n=8 |
| realtime | memory | eosToTranscript | 704 / 1463; 610 to 1463; n=5 |
| realtime | memory | textToAudio | 117 / 232; 92 to 232; n=5 |
| realtime | memory | thinkToAudio | 481 / 621; 435 to 621; n=5 |
| realtime | memory | thinkToRealAudio | 518 / 657; 480 to 657; n=5 |
| realtime | memory | thinkQueue | 0 / 1; 0 to 1; n=5 |
| realtime | memory | thinkAgent | 10963 / 12691; 10069 to 12691; n=5 |
| realtime | memory | think | 10964 / 12692; 10069 to 12692; n=5 |
| realtime | memory | vendor llmTtfb | 279 / 389; 249 to 434; n=10 |
| realtime | memory | vendor ttsTtfb | 66 / 75; 62 to 75; n=5 |
| realtime | memory | vendor turnSilence | 320 / 320; 320 to 320; n=5 |
| realtime | memory | vendor audioSinceSilence | 12484 / 14051; 11968 to 14051; n=5 |

## Load and errors

The host exposes 24 cores, no cgroup CPU quota, and zero recorded CPU throttling. The host is shared and was busy. Calls alternate settings and record one-minute load every five seconds. Different load distributions remain a material confound. Low local CPU does not prove that scheduler or network delay is absent.

| Setting | Scenario | One-minute load, median / p90; range; n | Caller CPU percent of one core, median / p90; range; n | Generations | Cancelled generations | Generation errors | Missing real-answer marks |
|---|---|---|---|---:|---:|---:|---:|
| baseline | hello | 57 / 78; 29 to 83; n=20 | 2 / 3; 2 to 3; n=4 | 8 | 0 | 0 | 0 |
| baseline | memory | 50 / 60; 17 to 64; n=56 | 2 / 2; 1 to 2; n=5 | 10 | 5 | 0 | 0 |
| cache-full | hello | 59 / 74; 35 to 76; n=20 | 2 / 2; 1 to 2; n=4 | 8 | 0 | 0 | 0 |
| cache-full | memory | 55 / 72; 21 to 76; n=55 | 2 / 2; 2 to 2; n=5 | 10 | 5 | 0 | 0 |
| slim | hello | 53 / 73; 39 to 76; n=20 | 2 / 3; 2 to 3; n=4 | 8 | 0 | 0 | 0 |
| slim | memory | 55 / 72; 27 to 74; n=57 | 2 / 2; 1 to 2; n=5 | 10 | 5 | 0 | 0 |
| slim-cache | hello | 55 / 79; 33 to 83; n=20 | 2 / 3; 1 to 3; n=4 | 8 | 0 | 0 | 0 |
| slim-cache | memory | 54 / 80; 31 to 85; n=57 | 2 / 2; 1 to 2; n=5 | 10 | 5 | 0 | 0 |
| slim-spec | hello | 57 / 91; 29 to 94; n=20 | 2 / 3; 2 to 3; n=4 | 8 | 0 | 0 | 0 |
| slim-spec | memory | 60 / 73; 44 to 78; n=55 | 2 / 2; 2 to 2; n=5 | 10 | 5 | 0 | 0 |
| agent | hello | 52 / 106; 23 to 118; n=43 | 2 / 2; 1 to 2; n=4 | 8 | 0 | 0 | 4 |
| agent | memory | 65 / 78; 24 to 84; n=56 | 2 / 2; 1 to 2; n=5 | 5 | 0 | 0 | 0 |
| realtime | hello | 54 / 122; 21 to 127; n=20 | 2 / 2; 1 to 2; n=4 | 8 | 0 | 0 | 0 |
| realtime | memory | 59 / 107; 24 to 122; n=52 | 2 / 2; 1 to 2; n=5 | 5 | 0 | 0 | 0 |

A separate 59-interval process-counter sample during the final matrix averaged 0.71% of one core for the PoC, 2.18% for the caller, 0.03% for cloudflared and 2.52% for the dev server. This rules out a continuously saturated local caller or PoC during that sample. It does not isolate remote compute from network time. The phase durations above identify the practical waits; remote hardware counters are unavailable.

The earlier pilot reproduced three memory failures with "Bot already thinking. Wait before asking another tool question." A replacement generation could start before cancellation cleanup released the bot slot. The implementation now queues replacement requests through cleanup. A real reproduction completed with the replacement bot request 1 ms after cancelled cleanup finished. The complete matrix reran after that fix. Pilot data stays under the matrix tag and is excluded here.

Four manually rejected Gemini answers account for every missing final answer mark. There are no negative answer intervals in the final matrix. All 63 conversations negotiated PCM 16 kHz input and output. Speculative cancellations remain in the generation counts, rather than disappearing as successful fast turns.

## Service availability

| Variant | Probe result | Decision |
|---|---|---|
| ElevenLabs Realtime Mini | Configuration HTTP 200, real full-context audio and think calls succeeded | Enabled, with configured ElevenLabs voice |
| OpenAI Realtime | Client-secret HTTP 200 and WebSocket 101, then credit_balance_exhausted on generation | Skipped, no functioning call option |
| Azure or configured Live | No Live key or Azure endpoint in the inspected config | Skipped, no credentials to probe |
| Groq slim | Earlier 5,521-token probe HTTP 200, 854 ms total | Optional route not benchmarked; current slim input is larger |

ElevenLabs selects Realtime Mini through conversation_config.realtime_model = eleven_realtime_v1_mini. Its current documentation describes a cascaded model. The product name is not proof of a fused speech-to-speech architecture. No OpenAI speed or Azure availability claim follows from a successful authentication handshake.

## Verification and retained evidence

The two follow-up settings are Realtime Mini and slim Haiku. Realtime Mini had the lowest small-talk median. Slim Haiku avoids cache prewarming and has overlapping results with both cached slim settings. This is a choice for further testing, not a performance ranking.

| Setting | Scenario | Outcome | Evidence |
|---|---|---|---|
| Slim Haiku | Interrupt | 1 of 1 passed, one real interruption and a completed short follow-up | logs/round2-best-two-interrupt.log, logs/round2-wire.jsonl |
| Realtime Mini | Interrupt | 1 of 1 passed, one real interruption and a completed short follow-up | logs/round2-best-two-interrupt.log, logs/round2-wire.jsonl |
| Slim Haiku | File tool | 1 of 1 passed, native Bash listed the copied workspace and returned actual file names | logs/round2-best-two-tool-validation.json |
| Realtime Mini | File tool | 0 of 2 passed, both stopped at native approval for a malformed compound listing command | logs/round2-best-two-tool.log, logs/round2-best-two-tool-retry.log |

The Realtime tool attempts do not prove file access. Their spoken fallback reused remembered names after the tool failed. Both owned pending dev turns were stopped. No permission policy was weakened. A voice approval handoff remains unresolved. The interrupt capture can contain residual audio from the interrupted response, so its alignment is not a comparable latency sample. One negative follow-up alignment interval for slim Haiku is excluded and retained in the follow-up summary. These follow-ups establish interaction observations, not latency percentiles.

The final browser run used the restarted HTTPS tunnel and WebRTC with a synthetic microphone. Engine, hosted Agent and Realtime Mini connected and received audio with no browser exceptions. The engine call selected slim context, cache, speculative generation and a seven-second timeout. The final screenshots show the current controls and qualified reasoning text. Browser speaking-mode timing is a separate proxy and does not enter the matrix tables.

| Acceptance check | Observed result | Local evidence under .data |
|---|---|---|
| Enabled variants complete real calls | All three completed final browser calls, plus the repeated tunnel matrix | logs/round2-final-ui.log, logs/round2-ui-errors.json, round2-page-*.png, round2-call-*.png |
| Stable prefix cache works | All 39 measured cached turns have positive cache reads | logs/calls.jsonl, round2-summary-matrix-final.json |
| Slim preserves identity and reduces input | Complete identity and SOUL match, ten recent messages, input below full context | logs/round2-context-validation.json, logs/calls.jsonl |
| Repeated counts and errors retained | 63 calls, 91 attempts, 87 real-answer marks, four semantic failures, 116 generations, 25 cancellations, zero non-cancelled generation errors | logs/round2-matrix-final-validation.json, logs/round2-scripted.jsonl, logs/round2-aligned.jsonl |
| Actual hosted models and audio formats | Final records identify Gemini or Realtime Mini as selected, all 63 calls use PCM 16 kHz | conversations/, logs/round2-format-validation.json |
| Phase, token and load report | Per-turn EOS, transcript, request, first token, first text and audio events, usage and load | logs/calls.jsonl, logs/round2-wire.jsonl, round2-summary-matrix-final.json |
| Best two interaction checks | Both interrupt checks pass, slim file check passes, two Realtime file failures retained | logs/round2-best-two-tool-validation.json, round2-summary-best-two.json |
| Canonical isolated fixture | Doctor, bot creation, send, settled wait and expected fake reply passed; owned fixture stopped | logs/round2-fixture-{doctor,bot,send,wait,messages}.json |
| Static checks | Scoped oxlint and shell syntax pass; standalone TypeScript reports 25 untouched product diagnostics and no PoC diagnostic | logs/round2-final-lint.log, logs/round2-final-typecheck.log |
| Source and process evidence | Measured source fingerprint, final source fingerprint, 59 CPU intervals and cgroup counters retained | source-sha256.round2-final.txt, source-sha256.round2-post-review.txt, logs/round2-final-active-cpu.jsonl, logs/round2-host-cgroup.txt |

The canonical verification instructions are docs/verification/README.md. The fixture proves isolated CLI send and wait. The real browser and tunnel calls prove the voice journeys. The TypeScript result is not a clean repository typecheck.

Manual thermo-nuclear quality review found no remaining blocking structural issue for this disposable scope. The final cleanup deleted the unused server guess for real-answer audio and its supporting fields. Reviewed alignment is the only real-answer authority. No executable file exceeds 1,000 lines. The result/report code remains separate from the call server. No independent review was performed.

The complete repeated matrix predates that telemetry-only deletion. No response-model, context, streaming or turn-taking behavior changed during collection. The stack restarted afterward. Both interrupt checks, the file checks and all three final browser calls use the final server. The native file failures above remain open observations.

## Method and limits

Scripted PCM uses 100 ms input frames and can contain trailing silence. EOS is the end of that PCM for round-one comparability, not an independently detected human speech endpoint. Telemetry posts use loopback to avoid adding a Cloudflare round trip to bookkeeping. Call creation, hosted tools and Speech Engine response traffic still use the actual tunnel. The separate browser checks use the actual HTTPS page and WebRTC.

Forced alignment maps reviewed answer words to received PCM chunks. It estimates word timing and does not establish speaker playback. Leading style tags, acknowledgments, promises to check and non-answer lead-ins were excluded. Every final transcript was inspected for these prefixes. Four incorrect Gemini responses were rejected entirely. No iPhone or human listening acceptance occurred.

The same copied bot thread evolves across calls. Memory prompts explicitly require think. This tests latency of the full-agent route, not independent memory accuracy. The single active hosted agent is updated before each call; this design does not support concurrent caller isolation. Native tools retain their capabilities, so snapshot separation is not an operating-system or network sandbox.

This is disposable code under poc/voice-call. It is not a product implementation or a deployment recommendation. A next product experiment should test Realtime Mini with human speech and the existing bot identity, and separately shorten or stream the full-agent tool path. Slim context remains a fallback experiment with a recall tradeoff. Caching has verified token reuse, but these timings do not justify a latency ranking.

Raw private evidence remains ignored under .data. It includes copied context and audio and must not be committed. The final matrix uses runTag matrix-final. The report command is in README.md. Source fingerprints before collection and after review are retained separately.
