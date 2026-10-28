# Limit refresh

GET /api/limit-resets?refresh=1 must call LimitResetClock.refresh(true) and await it. Normal GET uses ensureFresh and may return the cached report.

Runtime refusals retain their reset and matched exhausted window. Fresh usage clears a refusal only when that same window advances to a later reset and has capacity. Retain window provenance through intermediate lagging usage or failed provider reads. A successful turn also clears the refusal.

Verification: server/limit-resets.test.ts covers window matching and lagging reads; server/limit-reset.e2e.test.ts drives isolated control-omb servers with synthetic usage and real fake-engine refusals. Do not mutate live bot data for verification.