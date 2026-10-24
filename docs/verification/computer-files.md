# Saving recent changed files

Launch the isolated server and real Files component:

```sh
node --experimental-strip-types scripts/verify-computer-files.ts
```

Open the printed `previewUrl`. The fixture creates four synthetic files and
the fake engine's persisted reply links to three by absolute file URL. The
temporary project is the conversation's pinned working folder. The sealed
launcher has no Git, so the fixture supplies changed-file digest rows to the
renderer; all file requests still reach the real, unchanged server using the
persisted reply. No real engine, account, or application data is used. Ctrl-C
closes both fixture servers and removes only their temporary data.

Check the following in the browser:

1. `report #1.md` and `metrics.csv` have **Save a copy** buttons. Opening
   the Files tab must not download either file.
2. Save `report #1.md`. The button reports **Downloaded**, and the saved
   text contains the synthetic review. Its encoded file URL is sent with the
   stored reply's message ID through the existing file endpoint.
3. **Preview table: metrics.csv** opens the existing table preview, with
   Alpha / 12 and Beta / 7. Escape returns to the Files panel.
4. `missing.txt` is intentionally absent. Saving it shows the server's
   error rather than pretending it was downloaded.
5. `unshared.txt` says **Not shared**, explains that the bot must share a
   link in chat, and offers no download or preview. A digest is not a grant.
6. **Browse files** lists the conversation folder and the bot's shared
   folder. Drop a PNG, an MP4 and a subfolder into the printed project
   folder and press Refresh: folders open, the image shows, the video plays
   and seeks (the raw route answers `Range` with 206), and Markdown shows as
   text. The breadcrumb returns to any folder. `path=..` is refused with 400.
7. Repeat at a narrow viewport and with `?skin=atelier` for the light theme.
   Long file names must not push the panel wider.

Focused checks:

```sh
pnpm exec vitest run src/components/BotFolderBrowser.test.ts server/routes/bot-files.test.ts src/components/ComputerFilesPane.test.ts src/components/ComputerPanel.simple.test.ts src/components/AttachmentGallery.test.ts src/components/AttachmentPreview.test.ts server/message-file.test.ts scripts/testing/verification-docs.test.ts
pnpm typecheck
pnpm lint
pnpm i18n:check
pnpm build
```

The component tests cover the visible branch, exact thread/message scope,
encoded file URLs, Windows paths, explicit null pins, changed bot defaults,
deleted-file filtering, workspace refusal, and state reset on thread changes.
Authorization and containment remain the server's responsibility on every
click. "Changed in this chat" uses only existing Markdown file links and
stored file attachments, and never guesses by basename. The folder browser
reads through `GET /api/bots/:id/files` and `/files/raw`, rooted at the
conversation folder and the bot's shared folder only (never the global
attachments folder), with the same realpath, no-follow and inode checks as
message links; a Team Cloud member gets 404. `server/routes/bot-files.test.ts`
covers listing, ranges, traversal and the member refusal. This is not a
checkpoint test, or a packaged desktop/phone verification.
