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

Verified work ships without waiting for Clauber; do not leave it on a local
branch or stop to ask. `gsdtechsolutions/Legion` is the source of truth.

1. Branch with a conventional prefix (`feat/`, `fix/`, `docs/`), push it and
   open a PR against `main`.
2. Message Anvil, LEGION's release orchestrator (bot
   `a1ddaf91-0730-44ac-8c17-a0264d3d352d`, thread
   `03caa098-ce2f-418f-8ad2-3a89199f9fa1`): the PR link, what the change
   does, and what to check once it is live. From a T3 thread, send it with the
   `t3-legion-bridge` skill and a webhook callback, then end your turn.
   Anvil's answer wakes the thread; do not poll.
3. Anvil merges the PR once checks pass, then deploys. The deploy builds from
   the commit that is currently live, so nothing already deployed is dropped.
   It keeps a backup of the install, restarts only when no bot is mid-run, and
   verifies the service and the public URL. It then reports back to the
   sending thread.
4. If Anvil reports a failure, fix it on the same branch and message Anvil
   again. Clauber hears about a release only when it needs a decision outside
   `.agents/autonomy`.

Electron changes (`electron/`) only take effect in a new desktop build, so
say so in the PR rather than treating them as live.
