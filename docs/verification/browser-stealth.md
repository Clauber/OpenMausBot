# The built-in stealth browser

Bots' browsers can run as LEGION's own fingerprinted Chrome instead of
agent-browser's plain one. This recipe proves the stealth path end to end in
a disposable fixture. Each of the fake engine's scripted `agent_browser_*`
calls carries `"server": "browser"`, so it really runs on the turn's browser
MCP server and reaches `/api/internal/browser/mcp`. Every proof reads the
results the bot itself got back.

## Driving it

The recipe needs an `agent-browser` binary and a Chrome it may use; pass both
explicitly so a dev machine's ambient copies cannot leak in:

```sh
OMB_VERIFY_BROWSER_BINARY=$HOME/.openmausbot/tools/agent-browser/<version>/agent-browser \
OMB_VERIFY_BROWSER_CHROME=/usr/bin/google-chrome \
  node --experimental-strip-types scripts/verify-browser-stealth.ts
```

It prints each tool result, the session's CDP port record and fingerprint
files. It fails if any call failed, if the page script's `#ua` text or the
bot's `navigator` eval shows anything but the session's Windows Chrome
identity, or if an agent-browser process ran with the fixture's HOME or the
server log mentions agent-browser. The launcher adds only the Chrome's
directory and the one holding `Xvfb` to the fixture's sealed PATH.

## What it proves

- `browserEngine.stealth.enabled` parses, sticks through the config PATCH,
  and `debugPortBase` is honored (the fixture uses 19700, away from any live
  stealth service).
- A bot turn with the browser surface mounts through the stealth runtime:
  `data/stealth-browser/state/debug-ports.json` records the session's CDP
  port and that port serves Chrome DevTools.
- The fingerprint is generated once and persisted per session
  (`state/<session>-fingerprint.json`), and the page the bot read back
  reports the session's identity, both from its own load-time script and
  from a later eval. Headed, on this Linux host, with no display, which also
  proves the automatic Xvfb path.
- The in-process stealth engine served every call: no agent-browser daemon
  or CLI ran for the session.
- The Cloudflare auto-clicker (`browserEngine.stealth.cloudflare`, on by
  default) clears a locally-mocked "verify you are human" interstitial — a
  widget iframe whose URL contains challenges.cloudflare.com plus a checkbox
  while the bot only waits. No real Cloudflare traffic is involved.

## What it does not prove

- Acceptance by the real Cloudflare network: the mock proves the detection
  and click machinery; whether a given site's Cloudflare clears a given
  session depends on the identity and the requesting IP, and can only be
  observed on live traffic.
- The Desktop panel's stealth appearance; the recipe drives through the
  server's own integration, not the renderer.
- Persistence of logins across a server restart (the profile directories
  under `data/stealth-browser/profiles` are designed for it; the fixture
  does not restart the server).
