# Skills library: Hermes and shared skills, assigned per bot

Needs `features.skillsLibrary` on (`PATCH /api/config` in a fixture). Everything
runs in a disposable fixture; the user's data directory and the live service
are never touched.

## Getting skills in

Skills are plain folders. `scripts/mirror-skills.ts` pulls a source into
`<data dir>/skill-sources/<id>/`:

```sh
node --experimental-strip-types scripts/mirror-skills.ts hermes luna:/home/shado/.hermes/skills
node --experimental-strip-types scripts/mirror-skills.ts shared /workspace/ai/skills
```

- **Pull-only.** A remote source is read with `rsync` into a private staging
  folder, then `mirrorSkillTree` copies it; the source is only listed and read.
  The mirror refuses a folder it did not create, and a destination inside the
  source.
- **No credentials.** `.env*`, `*.pem`, `*.key`, `id_*`, and
  `token`/`secret`/`credential`/`password` data files are left behind, as are
  dot folders (`.archive`), links and files over 2 MB. The run prints each one.
- **Category folders** (those with a `DESCRIPTION.md`, like `web/` or `research/`)
  are walked to their child skills; the category becomes a tag.

Settings → Skills → Library then lists each source. **Import** lands skills
unapproved, like every library import; read one and approve it before it can be
assigned. A bulk import brings in only clean skills:

- skills that need Hermes or Luna (a `/home/shado` path, `~/.hermes` or
  `HERMES_HOME`, the `hermes` command, "Luna", a `10.69.42.x` service, or the
  Hermes-only `hermes-themes` / `hermes-desktop-plugins`) are held with the
  reasons and imported one at a time with **Import anyway**; they then carry a
  "Needs Hermes or Luna" badge;
- skills whose text embeds a secret-looking literal (an `sk-…` key, a bearer
  token, a GitHub/Slack/AWS token, a private key block, or a key assigned a
  literal value) are held too, import only after a confirm, and keep a warning.
  The finding names the kind, never the value;
- a SKILL.md with a block-scalar description or no name is converted on import
  (the note is kept as a warning); other frontmatter is left alone;
- supporting files (`references/`, `scripts/`) are not carried by the library
  and are listed on the skill ("Files not carried").

## Automated checks

```sh
pnpm exec vitest run server/skill-sources.test.ts src/lib/skill-assign.test.ts src/components/SkillAssignManager.test.ts src/components/SkillsSection.test.ts src/components/SkillsSection.behavior.test.ts
pnpm exec vitest run server/skill-sources.e2e.test.ts
```

`skill-sources.e2e.test.ts` proves the next-turn effect: an assigned but
unapproved skill is absent from the bot's system prompt; once approved it
appears in the "Imported skills" index of that bot's next turn only; removing
the assignment takes it out again.

## Browser check

```sh
OMB_PLAYWRIGHT_CORE=/path/to/playwright-core OMB_CHROMIUM=/path/to/chrome \
node --experimental-strip-types scripts/verify-skills-library.ts .agents/screenshots
```

Mirrors the real Hermes and shared folders into the fixture, imports through the
UI, approves a skill from each source, toggles assignments in the grid and the
by-bot view, and reads each next turn's skills index from the fake engine's dump.
