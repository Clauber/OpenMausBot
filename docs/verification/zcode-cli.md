# ZCode CLI turns against the real binary

A ZCode instance without `"server": true` runs each turn on its own `zcode app-server` child over
ZCode Protocol v4. The driver tests (`server/drivers/zcode.test.ts`) use a scripted fake. This
recipe runs the real binary through a fixture, with a throwaway home, so the person's ZCode
database and LEGION data stay untouched. Each prompt is one line, to keep plan usage small.

## Launch

```sh
node --experimental-strip-types scripts/control-omb.ts launch --extra zcode
```

The printed `dataDir` is also the fixture's `HOME`. Give it the ZCode runtime and the headless
provider config by link, then point the instance at the real wrapper. The instance reloads and
probes its models:

```sh
D=<dataDir>; U=<url>
mkdir -p $D/.zcode/headless
ln -s ~/.zcode/server $D/.zcode/server
ln -s ~/.zcode/headless/provider_config.json $D/.zcode/headless/provider_config.json
curl -sS -X PATCH -H 'Content-Type: application/json' -H "Origin: $U" $U/api/instances/zcode -d '{"cli":"'$HOME'/.local/bin/zcode"}'
pnpm control:omb new-bot --url $U --name Zed
pnpm control:omb set-model --url $U --bot <botId> --instance zcode --model '<a model id from `models`>'
```

Fixture bots start at Full access. For permission cards switch to Ask:

```sh
curl -sS -X PATCH -H 'Content-Type: application/json' $U/api/bots/<botId> -d '{"approvalMode":"ask","applyToAllThreads":true}'
```

## Prove it

- **A turn streams.** `pnpm control:omb run --url $U --bot <botId> --text 'Remember the word kumquat. Reply only: ok' --wait turn`.
  `$D/native/<threadId>.ndjson` holds the `row.delta` frames.
- **The next turn resumes with context.** Run with `--task <threadId>` and ask for the word. Each turn
  is a new child, so the answer comes from the resumed session.
- **A permission is approved once and denied once.** Send with `--wait none` and ask for a Bash
  write. One card appears in `GET $U/api/threads/<threadId>/messages`, however long it stays open.
  Answer it with `POST $U/api/threads/<threadId>/respond` and `{"requestId":"…","behavior":"allow"}`,
  or `"deny"` with a `message`. Check the file in `$D/task-workspaces/<botId>/<threadId>/`.
  `$D/.zcode/cli/db/db.sqlite` has no `local_setting` row afterwards: nothing was allowed always.
- **A question is answered.** Ask the bot to use AskUserQuestion with two options. The card lists
  them, and `{"requestId":"…","behavior":"answer","message":"blue"}` is the bot's reply.
- **Stop works.** Start a long reply with `--wait none`, then `pnpm control:omb interrupt --url $U --bot <botId> --task <threadId>`.
  The native log ends with a `completedInterrupted` turn header and no `app-server` child is left.
- **Project and user MCP servers reach the model.** After a first turn, write
  `<workspace>/.zcode/config.json` and
  `$D/providers/zcode/<sha256 of the instance id>/home/.zcode/cli/config.json`, each with one
  stdio server, and ask the bot to list the tools they add. Both answer next to the harness's
  own servers.
- **An attachment is read.** `curl -X POST --data-binary @red.png -H 'content-type: image/png' $U/api/attachments`,
  then send `<attached-image path="…" />` on its own line in a message to
  `POST $U/api/bots/<botId>/messages`. The native log shows a `zcode-artifact://` ref.

Compare `select count(*) from session` in `~/.zcode/cli/db/db.sqlite` before and after: it must not change.
