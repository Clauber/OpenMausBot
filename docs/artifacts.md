# Thread artifacts

Files a bot hands over with `attach_file` are recorded as versioned artifacts of the conversation, in `<data dir>/artifacts.sqlite` (`server/artifacts-db.ts`, `node:sqlite`, mode 0600).

`artifacts(id, threadId, botId, path, name, mime, size, version, createdAt, blob)`: `path` is the source path the bot named and, with `threadId`, identifies the file; `blob` is the private copy in the attachment store holding that version's bytes. Attaching the same path in the same thread again adds the next version (v1, v2, …); the same path in another thread starts at v1. Recording is best effort and never fails the attach itself.

## API

All three are normal authenticated routes (`server/routes/artifacts.ts`).

- `GET /api/threads/:id/artifacts`: the newest version of each file in the thread, with `url`. Scoped to that thread; 404 for an unknown thread.
- `GET /api/artifacts/:id`: download that version's bytes (`content-disposition: attachment`, `nosniff`). 410 if the stored copy is gone.
- `GET /api/artifacts/:id/versions`: every version of the file, oldest first.

## UI

Inspector → Run log shows "Files from this conversation" under the activity list when the thread has any. A file with more than one version has a version dropdown (latest first); the download link follows the selection.

Limits: the bytes live in the attachment store, so they are subject to its quota and cleanup like any attachment. Only `attach_file` registers artifacts today; images generated for chat avatars and user uploads do not.
