# Verifying the semantic memory provider

Fixtures only. The fake is a loopback HTTP server that implements `/v1/embeddings` and `/v1/search` and can be switched to answer 500 or hang; the data directory is a temp dir, so nothing touches a live app.

```sh
node --experimental-strip-types scripts/verify-semantic-memory.ts
pnpm vitest run server/memory-provider.e2e.test.ts server/recall.test.ts
```

The script and the test cover the same four cases:

1. **Off by default**: no provider resolves, recall equals the base recall, the fake sees no requests.
2. **Enabled**: provider passages appear after markdown ones with a `provider:` badge, a duplicate of a markdown passage is dropped, at most 3 are added, and the block stays within `RECALL_MAX_CHARS`.
3. **Failure**: a 500, a hang (gives up at 2 s) and a stub adapter all yield markdown-only recall.
4. **Key by reference**: the key reaches the fake only as `Authorization: Bearer`, via `apiKeyRef`; it is absent from console output (the fake echoes it in its 500 body) and from the status object the UI receives; an `apiKeyRef` outside `OMB_MEMORY_*` is rejected and never read.

UI: Settings → General → Semantic memory. Check the toggle, provider fields and that the key box is empty after save with only "A key is stored" shown.
