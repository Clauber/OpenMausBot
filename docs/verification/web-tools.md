# Verifying web tools

Fixtures only: a real harness with the fake engine in a temp data directory, and a loopback fake web server on 127.0.0.2.

```sh
node --experimental-strip-types scripts/verify-web-tools.ts
pnpm vitest run server/web-tools.test.ts server/web-tools.e2e.test.ts
```

1. **(a) fetch**: tags and scripts stripped, title kept, a 40k-word page capped at 30,000 characters with `truncated`, the second fetch `cached` and the fake sees one request.
2. **(b) SSRF**: `127.0.0.1`, `10.0.0.1`, `localhost` (resolved by DNS), `[::1]`, `169.254.169.254`, `ftp:` and a redirect to `10.0.0.1` are all refused with a clear error; the redirect target is never requested; each private refusal is a decision-log row. `web-tools.test.ts` adds a hostname whose DNS answer is private (rebinding).
3. **(c) search**: the fake HTML endpoint's three results parse into title, unwrapped URL and snippet.
4. **(d) tool selection**: a bot whose selection denies `mcp:agents:web_fetch` gets a 403 from the harness route (selection is set before the turn; it cannot change mid-turn).

The calls use the bot's real turn capability from the fake engine's dump.
