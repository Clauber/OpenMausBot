# Semantic memory provider

An optional provider that adds passages from your own embeddings server to what a bot recalls before a turn. It is **off by default**: with `memoryProvider.enabled` unset or false nothing new runs, and recall is exactly the markdown + chat-search recall described in [memory.md](memory.md). Those two sources always run; a provider only adds to them.

## Config

`config.json` (0600), section `memoryProvider`, also editable in Settings → General → Semantic memory:

| field | meaning |
| --- | --- |
| `enabled` | master switch, default `false` |
| `kind` | `generic-openai-embeddings`, `supermemory` or `serenity` |
| `url` | base URL of the provider (`http://127.0.0.1:8080/v1`) |
| `model` | embedding model name (default `text-embedding-3-small`) |
| `apiKeyRef` | the **name** of the environment variable holding the key; must match `OMB_MEMORY_*`, default `OMB_MEMORY_PROVIDER_KEY` |
| `key` | write-only. Saved to the 0600 config like every credential and loaded into `OMB_MEMORY_PROVIDER_KEY`; the provider reads it only through `apiKeyRef` |

The key is never returned by the config status (the UI sees `keyConfigured` and `apiKeyRef`), never logged (provider errors log the HTTP status only), and is dropped from engine child environments. `apiKeyRef` cannot name any non-`OMB_MEMORY_*` variable, so a provider cannot be pointed at another secret.

## Providers

`generic-openai-embeddings` is implemented against a user-supplied loopback or self-hosted server:

- `POST {url}/embeddings` with `{model, input}` returns `{data: [{embedding: number[]}]}`
- `POST {url}/search` with `{embedding, query, limit}` returns `{results: [{text, source?, score?}]}`

`supermemory` and `serenity` are clearly marked stubs. They throw "not configured" until URL and key are set, and then "adapter is a stub": their wire protocols are not implemented here. Add one by registering a factory with `registerMemoryProvider` in `server/memory-provider.ts`.

## How it merges

`buildRecallWith` (server/recall.ts) starts the provider query, runs the markdown lookups meanwhile, then awaits the provider.

- 2 s deadline for both calls together. A 500, a timeout, a malformed answer or a stub all mean markdown-only; the turn never fails. A skipped provider logs one warning line.
- Hits already said by a markdown or conversation passage (same text, or one contains the other) are dropped.
- At most 3 provider passages, appended after markdown and conversation passages, and rendered inside the same 6,000-character `RECALL_MAX_CHARS` block. They can fill leftover room, never displace or enlarge it.
- Provider passages are labelled `provider:<name> · <source>`, and the recall log line counts them separately.

Verification: [verification/semantic-memory.md](verification/semantic-memory.md).
