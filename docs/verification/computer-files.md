# The Files tab's folder explorer

Launch the isolated server and real Files component:

```sh
node --experimental-strip-types scripts/verify-computer-files.ts
```

Open the printed `previewUrl`. The fixture creates synthetic files in a
temporary project that is the conversation's pinned working folder, and
supplies changed-file digest rows to the renderer because the sealed launcher
has no Git. Every listing and file read reaches the real, unchanged server. No
real engine, account, or application data is used. Ctrl-C closes both fixture
servers and removes only their temporary data.

Add a PNG, a short MP4 and a subfolder to the printed project folder, then
check the following in the browser:

1. The tree fills the tab: the working folder expanded, **Shared folder**
   collapsed below it, folders before files, one icon per file type.
2. Clicking a folder expands it in place. Arrow keys move, expand and
   collapse; Enter opens a file; the tree is one Tab stop.
3. Opening the MP4 shows it beside the tree when the panel is at least 36rem
   wide and below it when narrower. It plays and seeks (the raw route answers
   `Range` with 206). The PNG shows as an image and Markdown as text. The
   divider drags and moves with the arrow keys. **Close file** returns the
   whole pane to the tree.
4. Files the digest rows name as added or changed carry **A** or **M**, and
   their folders a dot.
5. **Up one folder** re-roots the tree at the parent, keeping what was
   expanded and open. It stops at the home folder, and the app's data folder
   (`~/.openmausbot`) never appears apart from the bot's own folders.
6. While the bot is working, a file written into an expanded folder appears
   within a few seconds without pressing Refresh.
7. Reloading the page restores the same root, expanded folders and open file.
8. Repeat at a narrow viewport and with `?skin=atelier` for the light theme.
   Long file names must not push the panel wider.

Focused checks:

```sh
pnpm exec vitest run src/components/BotFolderBrowser.test.ts src/lib/file-tree.test.ts server/bot-files.test.ts server/routes/bot-files.test.ts src/components/ComputerPanel.simple.test.ts server/message-file.test.ts scripts/testing/verification-docs.test.ts
pnpm typecheck
pnpm lint
pnpm i18n:check
pnpm build
```

The explorer reads through `GET /api/bots/:id/files` and `/files/raw`. Their
roots are the conversation's working folder and the bot's shared folder,
never the global attachments folder, with the same realpath, no-follow and
inode checks as message links. Climbing above the working folder stops at the
home folder and is refused on Cloud and hosted servers. Inside the data
folder only the bot's own workspace and task folders are readable. A Team
Cloud member gets 404. `server/bot-files.test.ts` and
`server/routes/bot-files.test.ts` cover each limit. This is not a packaged
desktop or phone verification.
