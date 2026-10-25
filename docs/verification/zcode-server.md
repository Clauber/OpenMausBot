# ZCode server mode

A ZCode instance normally runs each turn in its own `zcode app-server` process. With
`"server": true` in the instance's config it runs turns on one shared ZCode server instead.
The server brings the account plans (Start Plan and Z.ai Individual), each model's real effort
levels, and mid-turn input (steer). Without the switch, or when the server cannot start for a
new conversation, the app-server path runs exactly as before.

## How it fits together

- **One server for every ZCode instance.** `bin/zcode serve` listens on a loopback port, with
  its own data folder at `<data>/providers/zcode/server` (login, personal providers, sessions).
  The ingress token stays in memory. The last turn to finish starts an idle timer (two minutes);
  a server left running by an earlier Legion is adopted, not duplicated.
- **One Z.ai login, one home per bot.** The login lives in the server's data folder. The server
  starts each agent through a wrapper that points `HOME` at the instance's bot home
  (`<data>/providers/zcode/<sha256 of the instance id>/home`, the same folder the app-server
  path uses), so each instance keeps its own hooks, MCP servers, `AGENTS.md` and skills.
- **Conversations stay where they started.** A CLI session id (`sess_…`) keeps using the CLI and
  a server session id (`session_…`) needs the server, so switching the mode never drops context.
- **Models.** The picker lists the server's models with the ids Legion already uses
  (`provider/model$level`) and offers each model's effort levels as variants. A bare
  `provider/model` id takes the level the list shows for it. A bad id or level fails the turn.
- **Where the server comes from.** `OMB_ZCODE_SERVER_PATH` (a folder holding `bin/zcode` and a
  server `manifest.json`), else the managed copy in `<data>/tools/zcode-server`, else a server on
  `PATH`. Nothing downloads on its own: `POST /api/instances/<id>/install` fetches the pinned
  official release, checks its size and SHA-256, and switches it in. Windows has no release.

## Turn it on and sign in

```sh
# Enable server mode on a ZCode instance (it reloads; bots using it must be idle).
curl -sS -X PATCH -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:8799' \
  http://127.0.0.1:8799/api/instances/<instanceId> -d '{"server": true}'

# Install the official server, if none is found:
curl -sS -X POST -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:8799' \
  http://127.0.0.1:8799/api/instances/<instanceId>/install -d '{}'

# Start the Z.ai sign-in. Open auth.authorizationUrl in a browser and approve before auth.expiresAt.
curl -sS -X POST -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:8799' \
  http://127.0.0.1:8799/api/instances/<instanceId>/auth/start -d '{}'
# Then poll until phase is "succeeded":
curl -sS 'http://127.0.0.1:8799/api/instances/<instanceId>/auth/status?flowId=<flowId>'
```

Sign-in has no panel in the settings UI yet. Credentials are never copied between machines or
data folders: sign in on the machine that runs the server.

## Prove it

The functional test starts the real server and runs real turns against a loopback model stand-in.
It uses a throwaway HOME and data folder and never touches the person's app, account or models.

```sh
OMB_ZCODE_SERVER_E2E_ROOT=/path/to/zcode-server pnpm exec vitest run server/zcode-server.e2e.test.ts
# optional, the CLI-path resume check against a real zcode install:
#   OMB_ZCODE_CLI_E2E_CLI=/path/to/zcode  OMB_ZCODE_CLI_E2E_SERVER_ROOT=~/.zcode/server
```

Without `OMB_ZCODE_SERVER_E2E_ROOT` the test is skipped; a skip verifies nothing. It checks:

1. The model list shows the server's models, and assistant text reaches Legion while the model is
   still streaming, long before the turn completes.
2. Two bots running at once: each model request carries its own bot's `AGENTS.md` and skill and
   neither the other bot's nor the person's, and each bot's hook ran in its own home only.
3. A write asks first, runs once allowed, and does not run when denied.
4. Stop settles a running turn as interrupted.
5. Steer: guidance sent during a running tool call reaches the model in the same turn, and the
   turn completes once.
6. A provider that keeps dropping the stream: the same session resumes and finishes, on the
   server path and (with the CLI variables) on the app-server path.

The focused driver tests (`server/drivers/zcode*.test.ts`, `server/drivers/zcode-server/*.test.ts`)
cover the same behaviors against scripted fakes (`server/testing/fake-zcode-server.ts`).

The test does not prove: an account turn on Start Plan or Individual (it needs a signed-in
server; run one by hand after signing in), the 0.67 plan coefficient, or the settings UI.
