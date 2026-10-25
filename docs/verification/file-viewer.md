# File viewer: inline previews instead of downloads

A file chip in the transcript, or a bot-authored Markdown link to a local
file, opens a docked **Files** panel with one tab per file. Text and code
render as source (bounded to 1 MB, larger files show the beginning), PDFs
embed the browser's viewer, images render inline, and anything else offers a
save button. Every tab still fetches through
`POST /api/threads/:tid/messages/:mid/file`, so the server re-proves the
per-message grant on each view — the panel adds no new route and no new
authority. The download affordance stays: a separate save button on each
chip, one in the panel header, and without the panel mounted (secondary
windows, bare test mounts) chips keep their previous download-only behavior.

## Recipe

Launch the isolated fixture (see [Chat UI](chat-ui.md) for the verb set) and
seed the fake engine with a reply that links real files from the bot's
workspace — the same wrapper-CLI shape the
[chat and settings polish fixture](chat-polish.md) uses:

```sh
node --experimental-strip-types scripts/control-omb.ts ui launch
# write report.md, metrics.csv and app.py into $DATA_DIR/workspaces/$BOT_ID,
# then register a wrapper CLI whose FAKE_CLAUDE_REPLIES holds Markdown links
# to those three absolute paths, via PATCH /api/instances/claude
H=/tmp/openmausbot-verify-data-*/ui.json
pnpm control:omb ui type --ui $H --name "Message Pepper" --text "Please share the files"
pnpm control:omb ui press --ui $H --keys Enter
pnpm control:omb ui wait-settle --ui $H --timeout 60
pnpm control:omb ui snapshot --ui $H
```

The transcript landmark shows the reply and the three file cards. Clicking a
chip (`ui click --name "View report.md"`) opens the panel; the snapshot then
contains a `tab "report.md"` inside the `Files` landmark and the seeded text.
Clicking a second file adds a tab; closing tabs (the `×` on each tab)
activates the neighbor and, on the last one, closes the panel. Inline
Markdown links in the reply open the same panel.

Evidence assertions:

```sh
pnpm control:omb ui eval --ui $H --js "Boolean(document.querySelector('aside[aria-label=\"Files\"]'))"
pnpm control:omb ui eval --ui $H --js "document.querySelectorAll('[role=\"tab\"][aria-selected=\"true\"]').length"
pnpm control:omb ui screenshot --ui $H --out docs/verification/evidence/file-viewer/file-viewer.png
pnpm control:omb ui console --ui $H
```

A direct-open regression (no grant, no viewer): legacy chips without message
context stay inert, and the viewer's failed state offers retry rather than a
stack trace. The permanent unit coverage lives in
`src/lib/file-viewer.test.ts` (renderer choice, truncation), the `file
viewer panel` block of `src/state/store.test.ts` (tab lifecycle, panel
exclusivity) and `src/components/AttachmentPreview.test.ts`.

## What this proves, and what it does not

Proven: the real renderer opens file chips and bot Markdown links into a
tabbed inline viewer, content is served through the existing message-scoped
authorization, tabs switch and close, and the panel respects the one-side-
panel rule. Not proven: Electron window chrome around the docked panel,
native (iOS/Android) transcripts, and real-provider behavior.
