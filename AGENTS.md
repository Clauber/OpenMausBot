# OpenMausBot agent notes

Before claiming a server or conversation change works, follow
[`docs/verification/README.md`](docs/verification/README.md). Always launch an
isolated fixture; never verify mutations against the user's live app or data.

More specific `AGENTS.md` files override this note within their directories.

## Shipping

Verified work goes to `main` as soon as it is done; do not leave it on a local
branch. Branch with a conventional prefix (`feat/`, `fix/`, `docs/`), push to
`fork`, open a PR against `fork/main`, and merge it once checks pass. Then
deploy to the live instance: build from the commit that is currently live so
nothing already deployed is dropped, keep a backup of the install, and verify
the service and the public URL afterwards. Check that no bot is mid-run before
restarting; interrupting a running turn needs the person's say-so.

Electron changes (`electron/`) only take effect in a new desktop build, so
say so in the PR rather than treating them as live.
