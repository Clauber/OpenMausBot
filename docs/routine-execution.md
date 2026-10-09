# How routines run: script, script + Jev, or the bot

A routine is a bot turn on every run unless something better is approved.
Much recurring work is a fixed procedure (fetch a page or API, compare a
number, format a short report) that a Python script does for free. When a
routine is created, or its instructions change, a reviewer model reads it
and proposes one of three modes:

| Mode | Each run |
| --- | --- |
| **Bot** (`llm`) | The bot runs, as before. |
| **Script** (`script`) | An approved Python script runs; its output is the report. No model. |
| **Script + Jev** (`script-jev`) | The script runs, then the [decision model](decision-model.md) is asked whether the output needs the bot. Only then does a turn start, with the output in its prompt. |

The verdict shows in **Routines**: a *Script suggested* badge in the list and
a **How it runs** panel in the routine's details and editor, with the reason,
the script, and **Approve script**, **Run the bot instead** and **Review
again**. A routine asked for in chat also gets a short note in that chat.

## Nothing runs unapproved

A proposed script never runs: the routine keeps running the bot until a person
approves it. Approval names the script's SHA-256, so a different script cannot
ride on it. Changing the routine's instructions drops the plan and its approval
and asks for a new review. Room goals, routines with attachments, and webhook
runs whose prompt differs from the routine's always run the bot.

## The script

Python 3, standard library only. It runs on the machine running OpenMausBot
with a fixed short environment (no workspace credentials), a time limit (the
routine's run limit, else 10 minutes; the whole process group is killed), and
a private working folder kept between runs at
`<data dir>/routine-state/<routine id>/`. `OMB_ROUTINE_ID`, `OMB_ROUTINE_NAME`
and `OMB_ROUTINE_LAST_RUN_AT` (epoch ms of the last completed run, or empty)
are set. Standard output is the report; empty output reports *Nothing to
report.* A non-zero exit fails the run, with its stderr in the run's thread,
and raises the usual routine-failed notification. A failed script never falls
back to the bot.

Run logs label each run *Ran as a script* or *Script, then the bot*.

## Jev, and failing open

Script + Jev asks the decision model one yes/no question (job `routineGate`),
with the routine's name, instructions and the script output, and the reviewer's
plain-words condition for when the bot is needed. At probability 0.5 or above
the bot runs. With Jev off, the job switched off (`decider.jobs.routineGate:
false`), no key, a timeout (5 s) or any error, the bot runs: the old behaviour.

## The reviewer

Any OpenAI-compatible chat endpoint, read on each review:

```json
"routineReview": { "enabled": true, "model": "sonnet-5", "baseUrl": "https://…/v1", "key": "…" }
```

Missing `baseUrl`/`key`/`model` fall back to `openaiCompat` (its `url`, `key`
and `model`); with neither, the routine bot's own engine where it can generate
text (Claude, chat-completion engines). With no reviewer at all, routines run
the bot and nothing is proposed. `enabled: false` stops reviews. There is no
Settings UI. `POST /api/routines/:id/execution/review` reviews an existing
routine; `…/approve` with `{ "scriptHash" }` and `…/use-bot` are what the
panel's buttons call.
