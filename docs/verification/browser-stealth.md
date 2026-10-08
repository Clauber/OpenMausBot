# The built-in stealth browser

Bots' browsers can run as LEGION's own fingerprinted Chrome instead of
agent-browser's plain one. This recipe proves the stealth path end to end in
a disposable fixture: a real bot turn drives the `agent_browser` tools, and
the page itself reports an identity that is the session's fingerprint, not
this host's Chrome.

## Driving it

The recipe needs an `agent-browser` binary and a Chrome it may use; pass both
explicitly so a dev machine's ambient copies cannot leak in:

```sh
OMB_VERIFY_BROWSER_BINARY=$HOME/.openmausbot/tools/agent-browser/<version>/agent-browser \
OMB_VERIFY_BROWSER_CHROME=/usr/bin/google-chrome \
  node --experimental-strip-types scripts/verify-browser-stealth.ts
```

It prints the page-reported identity, the session's CDP port record, and the
persisted fingerprint file, and fails closed if the browser the bot drove
reports this host's platform.

## What it proves

- `browserEngine.stealth.enabled` parses, sticks through the config PATCH,
  and `debugPortBase` is honored (the fixture uses 19700, away from any live
  stealth service).
- A bot turn with the browser surface mounts through the stealth runtime:
  `data/stealth-browser/state/debug-ports.json` records the session's CDP
  port and that port serves Chrome DevTools.
- The fingerprint is generated once and persisted per session
  (`state/<session>-fingerprint.json`), and the page the bot read back
  reports the fingerprint's user agent — headed, on this Linux host, with no
  display, which also proves the automatic Xvfb path.
- The Cloudflare auto-clicker (`browserEngine.stealth.cloudflare`, on by
  default) clears a locally-mocked "verify you are human" interstitial — a
  widget iframe whose URL contains challenges.cloudflare.com plus a checkbox
  — without a bot tool call. No real Cloudflare traffic is involved.

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
