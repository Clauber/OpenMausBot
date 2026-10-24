# LEGION marketplace staging

`https://legion-stg.gsdut.dev` runs this branch on the harness in the
`legion-stg` Compose project. Its app, engine home and Caddy storage use
separate named volumes. No production workspace, credentials or Docker socket
are mounted. The image includes Codex and Claude Code; sign in to a provider
in staging before chatting with imported bots. Provider credentials persist in
the staging volume. The image does not include a browser automation runtime.

With Node 24 and the branch dependencies installed, build and deploy:

```sh
pnpm typecheck
pnpm build:server
pnpm exec vite build
LEGION_STAGING_TAG=marketplace-clis-20261021 docker compose -f deploy/staging/compose.yaml up -d --build
```

The image copies only compiled server/UI artifacts, bundled skills and the
package manifest. Use a new tag when shipping another build. Build from a
clean worktree and run the [Grok import verification](../../docs/verification/grok-import.md)
before replacing staging.

The proxy binds `10.69.42.164:8445`. Cloudflare's `gsdut.dev` tunnel has one
explicit route for `legion-stg.gsdut.dev` to that TLS origin, ahead of the
existing wildcard. The route uses `originServerName=legion-stg.gsdut.dev` and
`noTLSVerify=true` because the private origin uses Caddy's internal CA. Public
HTTPS uses Cloudflare's certificate. Existing tunnel rules are preserved.

To pair another browser, run this on the harness and use its single-use link
within five minutes:

```sh
LEGION_STAGING_TAG=marketplace-clis-20261021 docker compose -f deploy/staging/compose.yaml exec app node dist-server/openmausbot.js pair --label "Staging browser"
```

In the app, open **+ → Templates → Import → From Grok Bot**. Paste a marketplace
URL, then load it. Cursor sign-in can fetch the full template for an account
with Grok Bot access. Alternatively paste the bot's JSON export. **Start from
description** creates an approximation and does not copy its private setup.
Imports require an explicit preview confirmation. Skills start disabled and
routines paused; app connections need their own credentials.

The authenticated Cursor download depends on an upstream private RPC. The
isolated tests cover its request/response contract; a real account download
still needs verification after sign-in. The public Dr Eggbot link and manual
export conversion were verified against the real LEGION UI.

Stop staging without deleting its data:

```sh
LEGION_STAGING_TAG=marketplace-clis-20261021 docker compose -f deploy/staging/compose.yaml stop
```

Rollback uses a previously verified image tag with `up -d --no-build`.
Do not run `down -v` unless intentionally deleting staging data. The production
`openmausbot.service` and `openmaus.gsdut.dev` are separate from this project.
