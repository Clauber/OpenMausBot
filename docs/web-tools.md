# Web tools: web_fetch and web_search

Two agent tools on the built-in `agents` MCP server. The bot calls them; the harness runs them (`server/routes/web-tools.ts` → `server/web-tools.ts`), so the network rules live in one place and not in each engine.

## web_fetch

`web_fetch {url}` returns the page's readable text (scripts, styles and tags removed, entities decoded), the title, and `truncated`.

- Limits: 30,000 characters of text, 2 MB of body, 20 s timeout, up to 5 redirects.
- Only `http:` and `https:`; URLs with embedded credentials are refused.
- Cached per URL for 10 minutes (100 entries).
- Non-text content types (images, PDFs, archives) are refused with the type named.

### SSRF guard (`server/web-ssrf.ts`)

A fetch is refused when its host is, or resolves to, a loopback, private, link-local, CGNAT, multicast or reserved address (IPv4, IPv6 and IPv4-mapped IPv6). The connection uses a lookup that applies the same check to every address, so a name cannot pass the check and then connect somewhere else (DNS rebinding). Every redirect hop is validated again. The refusal says so plainly: `Refused: 10.0.0.1 is not a public web address…`.

A fetch is read-only, so it needs no approval (`web_fetch` and `web_search` are in the read-only agent tool list). A refusal of a private-looking target is written to the decision log as `auto-denied`, source `outbound`, rule `ssrf-private-host`, with the bot, thread and URL.

## web_search

`web_search {query}` returns up to 8 `{title, url, snippet}` results. Read a result with `web_fetch`; search never fetches the result pages itself.

Provider (`webSearch` in config):

| field | meaning |
| --- | --- |
| `provider` | `duckduckgo-html` (default, keyless: POSTs the query to the HTML endpoint and parses organic results) or `json-api` (GET `{url}?q=…`, expects `{results:[{title,url,snippet}]}`) |
| `url` | endpoint override; required for `json-api` |
| `apiKeyRef` | name of an `OMB_WEBSEARCH_*` environment variable holding a bearer key. The write-only `key` field fills `OMB_WEBSEARCH_KEY` |

## Per-bot control

Both tools are on by default. Switch one off for a bot with its tool selection (Access settings) by denying `mcp:agents:web_fetch` or `mcp:agents:web_search`. The MCP gate hides the tool from the bot, and the harness route refuses the call too (403, "turned off for this bot").

## Testing seam

`OMB_TEST_WEB_FIXTURE_HOST` (a loopback address from 127.0.0.2 up, never 127.0.0.1) is honored only inside the sealed verification fixture (`OMB_TEST_SEALED_PATH=1`) and lets a fake web server run while every other private address stays refused. See [verification](verification/web-tools.md).
