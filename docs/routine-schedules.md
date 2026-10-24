# Routine schedules

Ask a bot in ordinary language, for example:

> Prepare a report at 9 am on the first of every month, in Asia/Kolkata.

The bot turns calendar timing into a cron expression, and OpenMausBot validates
it. The existing confirmation card shows the rule, its timezone and the next
three dates. Nothing is scheduled until you confirm. The scheduler wakes the
bot at the matching time; no model runs in the background to check the date.

In **Automations → Schedule**, choose **Monthly**, **Yearly**, or **Custom cron
(advanced)** in the existing routine editor. Monthly offers days 1–31 and
**Last day**. The timezone defaults to your browser's zone for a new preset and
can be changed. Saved cron routines retain their own zone even on another
computer. Editing just a title or instructions preserves the exact schedule.

## Advanced cron

Cron uses five fields: **minute hour day-of-month month day-of-week**.
An explicit IANA timezone such as `America/New_York`, `Asia/Kolkata`, or `UTC`
is required. Examples:

| Timing | Expression |
| --- | --- |
| First of each month at 09:00 | `0 9 1 * *` |
| Last day of each month at 09:00 | `0 9 L * *` |
| Second Monday of each month at 09:00 | `0 9 * * MON#2` |
| January 1 at 09:00 each year | `0 9 1 1 *` |
| Weekdays at 09:00 and 17:00 | `0 9,17 * * MON-FRI` |
| Every 15 minutes during weekday working hours | `*/15 9-16 * * MON-FRI` |

The app uses [Croner](https://github.com/Hexagon/croner) to calculate dates,
shared by the server and preview. It does not create a second timer service.
Lists, ranges, steps, `L`, `W`, and `#` follow that library's calendar semantics.
As with standard cron, restricting both day-of-month and day-of-week means
**either** field may match; leave one as `*` when you intend just the other.
Seconds, year fields, macros such as `@reboot`, shell commands, and arbitrary
code are not accepted. The finest resolution is one minute.

For elapsed-time repetition such as **every 90 minutes**, use the existing
interval schedule. Cron fields describe calendar positions: `*/90` in the
minutes field does not mean every 90 elapsed minutes. Holidays, external events,
and conditions such as "after a payment arrives" are not calendar expressions;
use an appropriate event/webhook workflow instead of a fake weekly schedule.

## Dates, clock changes and downtime

- Dates that do not exist are skipped: the 31st skips shorter months and
  February 29 runs in leap years. **Last day** handles every month.
- Daylight-saving gaps move the chosen wall-clock time forward through the
  gap. During a repeated hour, a matching clock time runs once, at its first
  occurrence. The preview uses the same calculation as execution.
- Routine execution defaults to **Bot’s current setup**: its selected model and
  configured computer, including a self-hosted VPS. No Boat key is needed for
  that VPS. **Boat cloud computer** is a separate, explicit choice: the bot's
  own model works on its Boat. The agent tools call these `run_on: "maus"` and
  `run_on: "box"`; legacy stored `runOn: "cloud"` still means Boat and is not
  migrated to a different runner.
- OpenMausBot must be running to dispatch routines, including cloud-targeted
  routines. There is no external always-on scheduling service: the schedule
  runs inside the app on your computer — it is not Grok's or anyone's cloud —
  so a sleeping computer or a quit app runs nothing, and the app cannot wake
  a sleeping Mac. The desktop app does the one thing it can: while plugged
  in, it keeps the computer from idle-sleeping for the hour before a due
  routine and while one runs (Automations → *Keep this computer awake for
  routines*, on by default; a closed lid still sleeps). For true 24/7, run
  OpenMausBot on a VPS — see [deploy-vps.md](deploy-vps.md).
- Existing catch-up policy remains: up to 12 hours late, one missed occurrence
  can be dispatched; older work receives a missed-run receipt. The next date
  advances without replaying every missed minute. Queued/running/waiting work
  for the same cron routine does not accumulate overlapping copies.
- Existing one-time, daily/weekday and interval schedules are not migrated or
  reinterpreted. Team exports retain cron expressions and zones; imports remain
  paused until enabled. Older phone apps safely treat cron as a newer schedule;
  use chat or the desktop/web editor for it, rather than converting it to daily.

Cron series are edited through the routine editor rather than calendar dragging,
which could otherwise ambiguously change an entire expression. Dense calendar
projections are bounded per day; Run logs remain the source of actual outcomes.

## Optional local pre-check

A bot routine may have a locally approved `preCheck` through the routine API
or a reviewed routine proposal. It executes on the OpenMausBot server, even
when the bot itself uses a remote computer. The calendar editor displays an existing check in Advanced and preserves
it when editing other fields; configure the executable through
the API or proposal rather than entering a shell command in the schedule.

```json
{
  "preCheck": {
    "command": "/absolute/path/to/inbox-check",
    "args": ["--read-only"],
    "timeoutMs": 30000
  }
}
```

`command` must be an absolute executable path. `args` are literal arguments:
OpenMausBot spawns the executable directly, without a shell or expansion.
The default timeout is 30 seconds; a configured timeout must be a whole
number from 100 to 60,000 milliseconds. No more than 64 arguments, each at
most 4,096 characters, are accepted. Do not put credentials in arguments:
use the executable's own designated secure authentication files instead.
Checks inherit only bounded OS path/home/temp/locale/timezone variables,
SSH-agent discovery and XDG configuration/runtime paths. Provider and decision
keys from the server environment are not passed to them. This configuration
selects an executable; it does not grant it server secrets. A proposal
shows the executable, arguments and timeout for review. A PATCH with
`preCheck: null` removes it; omitting the field preserves it.

The executable must exit successfully and write exactly one JSON object to
stdout, with this shape (diagnostic text belongs on stderr):

```json
{"items":[{"source":"mail","id":"message-1","from":"sender@example.com","subject":"Support request","channel":"inbox","snippet":"Please review this issue."}]}
```

The whole array is validated before use. Unknown fields, missing required
fields or wrong types invalidate the whole result. Limits are 64 items and
16,000 UTF-8 bytes of serialized item JSON, with at most 200 characters for
`source` and optional `channel`, 500 for `id` and `from`, 1,000 for optional
`subject`, and 2,000 for `snippet`. Source and id must be nonempty, and each item must include subject or channel. Combined
stdout and stderr are limited to 48 KiB. Over-limit output is never silently
clipped or partially classified.

An empty array records **Skipped** in Run logs and creates no bot turn or
chat run card. Nonempty items normally wake the bot and are added to its
prompt as untrusted data. With **Settings → Decision model → Wake routines
for useful items** on, the fixed `routineWake` decision can also skip when it
returns `noise_only` at probability 0.7 or above. This switch starts off.
Every uncertainty, invalid answer, missing key, timeout, process error or
malformed persisted configuration falls back to normal dispatch. The full
instructions and complete item set must fit the decision budget; otherwise
the bot wakes without asking the classifier.

Only scheduled bot routines use pre-checks. **Run now** always bypasses them,
including on a paused routine, because it expresses explicit manual intent.
Webhook deliveries and room goals keep their existing dispatch behavior.
Each scheduled run snapshots its check and instructions. Checked items are
saved before the optional decision, retained while the target is busy and
reused after restart. Cancellation, pause or deletion during an awaited
check cannot start a turn afterwards; cancellation aborts the executable and
cleans up its process group. Items already returned and saved stay on the
cancelled receipt. This protocol does not transactionally acknowledge script
state: a crash or cancellation between script output and a script's own state
write can cause a repeat or an undelivered candidate. Use read-only,
idempotent checks and reconcile with the source in the bot's actual turn.

Portable bot/team/package exports omit executable pre-check authority.
Workspace backups retain historical receipts, but restoring one removes
executable checks from routine definitions and pauses schedules. Reconfigure
and review each executable locally before enabling it on another machine.
