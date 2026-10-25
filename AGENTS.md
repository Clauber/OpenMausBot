# OpenMausBot agent notes

Before claiming a server or conversation change works, follow
[`docs/verification/README.md`](docs/verification/README.md). Always launch an
isolated fixture; never verify mutations against the user's live app or data.

## Comments

Write a comment only for what the code cannot say:

- a license or attribution notice;
- a fact forced by something outside this code (a vendor, CLI, OS, browser,
  Electron or protocol behaviour), with its version when it has one;
- the doc comment of a public contract: the wire types in `shared/`, the
  driver interface, the preload bridge, `config.json` fields people edit;
- a link to an upstream issue;
- a security invariant or a known open risk.

Do not narrate what the next line does, restate a name, record history ("used
to", "no longer", PR or issue numbers, plan or slice names: git has it), point
at other files, draw banners or leave commented-out code. When our own code
needs a paragraph to explain a surprise, change the code instead: a better
name, a type, an extracted function, one shared helper. A rule ("never X",
"must match Y") belongs in a type, a test or a lint rule. Never suppress a lint
rule that guards correctness; fix the code.

More specific `AGENTS.md` files override this note within their directories.

## Shipping

Verified work goes to `main` as soon as it is done; do not leave it on a local
branch. `gsdtechsolutions/Legion` is the source of truth. Branch with a
conventional prefix (`feat/`, `fix/`, `docs/`), push to it, open a PR against
its `main`, and merge it once checks pass. Then
deploy to the live instance: build from the commit that is currently live so
nothing already deployed is dropped, keep a backup of the install, and verify
the service and the public URL afterwards. Check that no bot is mid-run before
restarting; interrupting a running turn needs the person's say-so.

Electron changes (`electron/`) only take effect in a new desktop build, so
say so in the PR rather than treating them as live.
