# stealth-browser

A patchright Chrome service with per-profile fingerprints and evasions. In
OpenMausBot it gives each bot's persistent browser its own **headed** Chrome:
agent-browser attaches to that Chrome over CDP, so the bot's browser tools and
the Browser panel drive the same window, and a person can click through a
challenge the bot cannot. Guest browsers stay on the managed engine.

## Run it beside OpenMausBot

Needs Google Chrome, Xvfb and Node 20+ on the server.

```sh
npm ci && npm run build
cp deploy/stealth-browser.service ~/.config/systemd/user/   # adjust paths
systemctl --user daemon-reload && systemctl --user enable --now stealth-browser
```

Then point OpenMausBot at it (Settings JSON or `PATCH /api/config`):

```json
{ "browserEngine": { "stealthUrl": "http://127.0.0.1:9379" } }
```

The service has no authentication: keep `HOST=127.0.0.1`. Each profile keeps
a fixed CDP port (`STATE_DIR/debug-ports.json`), so a bot reattaches to the
same address after the service restarts. `VIEWPORT=1280x720` matches the page
size the Browser panel maps input onto.

In an unprivileged LXC, Chrome's AppArmor profile can deny its sockets
(`CreatePlatformSocket() failed: Permission denied`); disable it with
`ln -s /etc/apparmor.d/chrome /etc/apparmor.d/disable/ && apparmor_parser -R /etc/apparmor.d/chrome`.

## Develop

```sh
npm test        # launches real Chrome
npm run typecheck
```
