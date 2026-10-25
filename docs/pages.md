# Pages

Pages turns useful bot output into documents you can keep editing. Open **Pages**
in the sidebar, create a page, or choose **Save conversation as page** to copy the
selected conversation's text on its current branch. The source thread is retained
as a backlink. Tool output and hidden branches are omitted; transcripts over
100,000 characters must be shortened before saving.

Select a document in the page tree. Edit its title and Markdown beside a live
preview. Changes autosave after 1.2 seconds; **Save** saves immediately. Drafts
are retained in this browser, per workspace and page, through navigation and
reload. A storage failure is shown in the save status; keep the editor open and
save before leaving in that case.

Each save checks the revision you started with. If another editor saved first,
your local draft stays in place and autosave stops. **Overwrite latest with my
draft** explicitly replaces the latest saved title and content. If someone saves
again during that operation, the conflict remains. Network failures retain your
draft and pause automatic retry until another edit or manual save.

**New child page** nests a page beneath the selected document. Use **Parent** to
move a saved page. Cycles and parents in another space are refused. Delete or move
children before deleting their parent. Search matches words in titles and content.

**Open page chat** starts a separate conversation with the chosen bot. Each turn
receives the page's latest saved title, revision and content as reference context.
The first 24,000 content characters are included, with an explicit truncation flag
for longer pages. Drafts are excluded until saved. The bot can call `propose_page`
to offer a new document; its existing approval card shows the exact draft. **Save
page** creates it server-side, and the settled card links to the page. Retrying the
same proposal or approving it twice creates one document. Even a Full-access bot
must obtain review before a proposed page is saved.

Pages links use `#/pages/<id>`. Pages belong to the default space in this MVP;
storage and APIs also support separate `spaceId` values. Workspace admins manage
Pages. Sharing, per-page permissions, TipTap, and slash commands are deferred.

## HTTP API

All routes use the harness authentication gate. Page routes require admin scope.
Every mutation requires `revision`: use `0` for a new page and the current stored
revision for an existing page. Conflicts return HTTP 409 with
`{"code":"stale_revision"}`; saved pages start at revision 1.

| Method | Route | Input / result |
| --- | --- | --- |
| GET | `/api/pages?spaceId=default` | `{pages}` |
| GET | `/api/pages/search?q=words&spaceId=default` | Ranked `{pages}`, at most 100 matches |
| POST | `/api/pages` | `{revision:0,title,content,parentId?,spaceId?}` → `{page}` |
| GET | `/api/pages/:id` | `{page}` |
| PATCH / PUT | `/api/pages/:id` | `{revision,title?,content?}` → `{page}` |
| POST | `/api/pages/:id/move` | `{revision,parentId}`; null means top level |
| DELETE | `/api/pages/:id` | `{revision}` → `{ok:true}` |
| POST | `/api/pages/from-conversation` | `{revision:0,threadId,title,parentId?,spaceId?}` → `{page}` |
| POST | `/api/pages/:id/chat` | `{revision,botId}` → `{botId,task,link}` |

Titles are nonempty and at most 160 characters. Markdown is at most 100,000
characters. Create responses use HTTP 201. Parent and source ids are nullable;
updates cannot rewrite a source backlink or directly change a parent.

The agents MCP server's `propose_page` tool accepts
`{proposal_id,revision:0,title,content,parent_id?,space_id?}`. Its proxy calls
`POST /api/internal/page-proposals` with a live agents capability scoped to the
sender bot and thread. Approval uses the normal
`POST /api/threads/:threadId/respond` body `{requestId,behavior:"allow"}` (or
`"deny"`). Only an admin can review Pages cards. Proposal receipts keyed by
`(threadId,proposalId)` and page creation commit in one SQLite transaction;
duplicate decisions survive process restarts. Reusing a proposal id retains the
first draft, so changed drafts need a new id.

Storage is an owner-readable `pages.db` sibling of `messages.db`, with WAL and
FTS5 indexes maintained by triggers. The schema keeps Markdown separate from
editor choice so a richer editor can be added later.
