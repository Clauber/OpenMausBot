# Decision model

OpenMausBot can use a fast decision model to pick things for your bots. It
answers in a few hundred milliseconds for a fraction of a cent. It never does
the work: the chosen bot still runs its own turn on its own engine. Two
providers are supported: TypeSafe's [Jev](https://typesafe.ai) (the default)
and a model of your choice on [OpenRouter](https://openrouter.ai).

Everything is in **Settings → Decision model**: the provider, for OpenRouter
the model, one master switch, that provider's key with **Save** and **Test**,
and one switch per job it can do. Each provider keeps its own key, so you can
switch between them without pasting a key again. OpenRouter needs no key here
when you already saved one under **Settings → API keys**: the decision model
uses that one.

## Choosing a provider

- **TypeSafe Jev** is a classifier built for this: it returns calibrated
  probabilities, and the 0.6 threshold below was measured against it.
- **OpenRouter** routes to one of OpenRouter's own *decisions models* (Jev,
  Perplexity's Decider, Mercury Decide and others), with the default
  `typesafe/jev-1.13` (Jev, billed to your OpenRouter account). They take Jev's
  request as it is and answer in Jev's shape, through OpenRouter's Decisions
  API, and the answer goes through the same checks. Calibration varies by
  model, so the 0.6 threshold has not been validated for each one; run the
  live eval (see "Measuring it") before relying on one. A wrong or unsure
  answer still only costs the fallback below. A general chat model can be
  saved by hand (`openrouterApi: "chat"`): it is asked for a strict JSON
  answer in the same shape through chat completions, and its probabilities
  are its own estimate.

The model list holds decisions models only: a curated set, in the order of
OpenRouter's decisions ranking, that shows only what OpenRouter's public
catalog (`/models?output_modalities=decisions`) still lists, then the rest of
that catalog. Chat models are not offered, though one saved by hand with
`openrouterApi: "chat"` still works. If OpenRouter's catalog cannot be
loaded, Settings shows the curated list and says so. A model saved by id (`decider.openrouterModel`) is
used even if the list does not carry it. **Test** shows how long the model took;
above 1.5 seconds, rooms would fall back to the lead, so pick a faster one.

## What it decides today

**Who answers in rooms.** A room whose responder is set to **Auto (Jev)** asks
the decision model (Jev or your OpenRouter model, whichever is selected) who
should answer each message that @mentions nobody. The room's labels keep the
name "Jev" under either provider. The question offers
the room's active bots, each described by name, title and description, plus
"several members". The state it reads is the room's name, its people, the last
room lines (the same window room turns use, clipped in size) and the new
message.

- If one bot comes back with a probability of at least 0.6, only that bot
  answers.
- If "several members" comes back at 0.6 or above, every member answers.
- Anything less sure goes to the room's fallback: the lead it had before it
  became Auto, or else its first member. That is what a lead-mode room does
  today.

@mentions, `@everyone`, team goals and the other responder modes never ask
the decision model. The message is appended and the send returns straight away; the answer
is awaited only when the room's turn starts, within 1.5 seconds.

A reply whose speaker the decision model picked shows a small line under it:
*Picked by Jev · 94%*, or *Picked by OpenRouter · 94%*.

New rooms start on Auto while the decider and its room job are on. Existing
rooms keep their mode. With Jev off, an Auto room shows a one-line hint and
answers like lead mode.

Click by description, fewer connected-app tools, where work runs, and
scheduled routine wake decisions change what a bot sees or does, so each starts off
until someone switches it on in **Settings → Decision model**. With the
switch off they cost nothing: no request is built.

**Fewer connected-app tools.** On the API engines that list their own tools
(Grok, Mistral, MiniMax and OpenAI-compatible), a turn whose connected-app
and custom MCP tools number more than 20 asks Jev, once per tool, whether
the message might need it. Each tool is described as "name: description"
(about 200 characters) beside the message (about 1,500).

- A tool is kept at a probability of at least 0.2, and the 5 most likely
  are always kept. The rest are not offered this turn, and a call to one is
  refused like any unknown tool.
- OpenMausBot's own tools (teammates, the computer, the browser, questions
  to you) and Composio's search, execute and connection tools are never
  asked about and never withheld.
- Past 120 tools (the most one request may carry), the first 120 are asked
  about and the rest are kept.
- Engines that run their own CLI (Claude, Codex, ACP, Pi) are not trimmed: they reach connected
  apps through Composio's search-and-execute tools rather than one tool per
  action, and listing the per-app tools there would cost a network round
  trip before every turn.

The question waits for the tool list, so it runs when the engine has
started its tool servers, within 1.5 seconds. Any failure keeps every tool.

**Where work runs.** For a bot whose Works on is Auto, in a conversation
that is not pinned to a place, a message you send asks Jev which place
fits it, choosing only among the places Auto could reach right now: this
computer, a Local VM this bot already has, and the cloud computer (a VPS that
is set up, or a Boat for the Computer engine). It is asked only when at least two of them are
there. The state is the message (about 1,500 characters) and the bot's
name and description (about 400).

- At a probability of at least 0.7, that place is tried first this turn,
  through the same Auto mount as always, so its first screen use pins the
  conversation just as an Auto turn does today. A place that does not
  attach leaves the usual order to run.
- Anything less sure keeps the usual Auto order.
- A pin (yours or an earlier Auto turn's), a bot's own Works on, a team
  computer, rooms, routines, webhooks and messages from other bots never
  ask.

The question starts with the turn and is awaited just before the computer
is mounted, within 1.2 seconds.

**Click by description.** With **Click by description** switched on (it
starts off), bots using the built-in browser get one more tool,
`agent_browser_click_text`. A bot names what to click in words ("the blue
Sign in button", "the Remember me checkbox") instead of reading a snapshot
and picking a ref. The tool takes a snapshot of the page, offers Jev up to
255 of its clickable elements (buttons, links, fields, checkboxes and so on,
each described by its role, label and the section it sits in), and sends
only the words and the page's address and title as the state.

Jev is also offered "none of these": a target that matches nothing on
the page, or is too vague to tell ("the thing"), clicks nothing however sure
Jev is, and the bot gets the likeliest candidates instead.

- If one element comes back with a probability of at least 0.6, it is
  clicked, and the bot is told what: *Clicked button "Sign in" (Jev 92%)*.
- Anything less sure, and any failure at all, clicks nothing. The bot gets a
  short list of the closest elements with their refs and clicks one itself,
  as it would without Jev.

With the switch off, or no key, the tool is not offered at all. A person
taking over the browser while Jev decides stops the click.


**Whether a routine script's output needs the bot.** A routine approved to run
as *Script + Jev* asks once per run; see [routine-execution.md](routine-execution.md).

## It fails open

The decision model never blocks or delays a turn beyond its short budget.
With no key, the switch off, the job off, a timeout, a network error, an HTTP
error (401, 429, 529, 5xx), or an answer that does not check out (a choice
that was not offered, a probability that is not a number, a choice that is
not the most likely option), the room does exactly what it would have done
without it. Every answer is validated before it is used, whichever provider
gave it.

OpenRouter adds a few failures of its own, all handled the same way: a model
that answers in something other than the JSON asked for, a 200 response that
carries an error, no host available for the model with the requested
parameters, and 402 when the account is out of credits. **Test** says the
account is out of credits for a 402.

## What is logged

Each call that reaches the model adds one row to
`~/.openmausbot/decider-log/YYYY-MM.ndjson` (mode 0600). This is separate
from the approvals log in `decisions/`.

```json
{"at":"…","seam":"roomRouting","provider":"jev","ok":true,"choice":"<bot id>","pTop":0.94,"margin":0.9,"latencyMs":341,"inputTokens":712,"stateHash":"3f1c…"}
```

With OpenRouter, `provider` is `"openrouter"` and the row also has a
`model` field with the model id that was asked. A row never holds the message text, the bots' descriptions or the key; a
16-character hash of the state is enough to spot repeats. Failed calls record
the reason (`timeout`, `overloaded`, …) and the HTTP status. Month files are
kept for the approvals log's retention window (180 days by default).
The log stays on this machine: workspace backups leave it out.

## Where the key lives

- **Desktop app:** in the operating system's encrypted store
  (`credentials.bin`), like the other workspace keys. The server receives the
  Jev key as `OMB_JEV_API_KEY` and the OpenRouter key as
  `OMB_OPENROUTER_DECIDER_KEY` at start-up; `config.json` keeps only an
  empty placeholder.
- **Server or browser use:** in the server's own `config.json` (mode 0600),
  under `decider.key` (Jev) or `decider.openrouterKey` (OpenRouter).
  `OMB_JEV_API_KEY` and `OMB_OPENROUTER_DECIDER_KEY` override them.
- **The OpenRouter key is shared with your OpenRouter models.** The decision
  model uses the first of these it finds:
  1. a key saved here, in **Settings → Decision model** (`decider.openrouterKey`
     or `OMB_OPENROUTER_DECIDER_KEY`): the optional "use a different key"
     override, which wins so a key saved before sharing keeps working;
  2. the OpenRouter key under **Settings → API keys** (`openrouter.key` or
     `OMB_OPENROUTER_API_KEY`);
  3. none: it is off until one is saved.

  With the shared key, Settings says **Using your OpenRouter API key** and links
  to **API keys**; the master switch is available without pasting anything, and
  **Test** checks the shared key. Choosing OpenRouter does not turn decisions
  on by itself: the switch stays off until you switch it on. Clearing a key
  saved here falls back to the shared key and leaves the switch as it is.
  Decisions spend from the same OpenRouter account as your OpenRouter
  models. The shared key is sent only to OpenRouter's own address: with an
  `openrouterBaseUrl` set to anything else, only a key saved here is used. If
  the shared key is later removed, a switch left on stops having any effect
  until a key is saved again.
- **Cloud Pro:** decisions are included, with no key to paste. With no key of
  the person's own, the Cloud home uses its relay token
  (`OMB_CLOUD_DECIDER_TOKEN`), sent only to the Admin's relay, never to Jev
  or `baseUrl`, and only for requests that match a job's fixed contract
  (room routing, the key check, and each job in `server/decider/jobs.ts`). Settings says **Included with your Cloud plan**, and
  the master switch is on until someone switches it off. A key saved here
  always wins; clearing it falls back to the included decisions. The relay
  speaks Jev's API only, so the included decisions are Jev's: with OpenRouter
  selected nothing is included and you need an OpenRouter key. See
  [cloud-pro.md](cloud-pro.md), "Included Boat computers, voice and
  decisions".

The keys are write-only: `GET /api/config` reports only whether one is saved,
the provider and model, and which switches are on. Engines never inherit
them, and diagnostics exports mask them. Saving a key makes one tiny test
call; a key the provider rejects is not saved. The **Test** button makes the
same call on demand. A Jev room decision costs about $0.00003; the test call
costs less. An OpenRouter decision costs whatever the chosen model charges,
usually a similar fraction of a cent.

## What leaves this machine

Each decision sends the state described above (the room's name, its people,
recent room lines and the new message) and the bots' descriptions to the
selected provider. With OpenRouter that is OpenRouter and the host it routes
the model to, under OpenRouter's privacy settings and your account's data
policy; OpenMausBot does not set a data-collection preference. Use Jev, or
leave the job off, for rooms that must not leave the machine.

## Turning it off

Switch off **Use Jev for fast decisions** (**Use OpenRouter for fast
decisions**), or clear the key (on Cloud Pro,
clearing a key falls back to the included decisions: switch off to stop
them; with OpenRouter it falls back to the key under **Settings → API keys**,
so switch off to stop them). To keep Jev on but stop room routing, switch off **Who answers in
rooms**. To stop one room asking, set its responder to a lead, **Everyone
responds** or **Only when mentioned**.

## Configuration reference

```json
"decider": {
  "enabled": true,
  "provider": "jev",
  "key": "",
  "baseUrl": "https://api.typesafe.ai",
  "openrouterKey": "",
  "openrouterModel": "typesafe/jev-1.13",
  "openrouterApi": "decisions",
  "openrouterBaseUrl": "https://openrouter.ai/api/v1",
  "jobs": { "roomRouting": true }
}
```

`provider` is `"jev"`, `"openrouter"` or `"off"`. A config with no
`provider` is Jev, so existing files keep working unchanged. `openrouterKey` is
optional: left empty, the decision model uses the top-level `openrouter.key`.

`baseUrl` points at a Jev-compatible server instead of TypeSafe's. It has no
Settings UI. It must be https, or http to this machine only. Requests go to
`{baseUrl}/v1/systemone` with model `jev-latest`.

`openrouterModel` is an OpenRouter model id (`vendor/model`); unset means
`typesafe/jev-1.13`. `openrouterApi` says which OpenRouter API serves it:
`"decisions"` or `"chat"` (the default for a saved model; the default model is
a decisions one). Settings sets it from the model picked, and saving a model
without it makes it `chat`. `openrouterBaseUrl` points at another
OpenRouter-compatible server instead of OpenRouter, with the same
https-or-loopback rule and no Settings UI; only `openrouterKey` is sent there,
never the key from **Settings → API keys**. A chat model's requests go to
`{openrouterBaseUrl}/chat/completions` with `temperature: 0`, a strict JSON
schema, and `provider.require_parameters`; no `reasoning` option is sent. A
decisions model's go to `/alpha/decisions` beside it (for the default base,
`https://openrouter.ai/api/alpha/decisions`), with Jev's request body. That
API is alpha at OpenRouter and may change. The model list comes from
`GET /api/decider/models`, which needs no key and spends nothing.

## Measuring it

`server/decider/room-routing.eval.test.ts` replays 53 labelled room messages
(`server/decider/fixtures/room-routing.json`) against the live model. It is
skipped unless `OMB_JEV_LIVE_EVAL=1` is set with a key, and costs about
$0.002 per run. The same eval runs against OpenRouter with
`OMB_OPENROUTER_LIVE_EVAL=1` and `OMB_OPENROUTER_DECIDER_KEY`, using the
model in `OMB_OPENROUTER_EVAL_MODEL` (else the default); the cost depends on
the model. It is the check for whether a model's own probabilities hold up at
the 0.6 threshold.

## Scheduled routine wake decisions

**Wake routines for useful items** (`routineWake`) starts off. It applies only
after a scheduled bot routine's local pre-check returns a fully validated,
nonempty item array. Empty arrays skip without a decision-model request.
Manual Run now, webhook runs and room goals bypass the pre-check path.

The fixed question asks whether any item needs the work described by the
routine instructions. Its only choices are `needs_bot` and `noise_only`.
Only `noise_only` with a finite probability from 0.7 to 1 skips. All other
answers and failures wake the bot. Items are untrusted data, and all checked
items are passed to a woken bot. The classifier receives the complete
instructions and item set within 24,000 UTF-8 state bytes; exceeding that
budget wakes the bot instead of classifying a truncated request. The call
uses the existing decision relay and logging path, with a 1.5 second budget.

Skipped runs appear only in central Run logs, without a chat card or engine
turn. The local contract in `server/decider/jobs.ts` must also be installed in
the Cloud Admin's fixed-contract relay before Cloud Pro's included token can
serve this job. A relay that does not recognize it fails open; an own key
uses the normal Jev-compatible endpoint. See
[routine-schedules.md](routine-schedules.md#optional-local-pre-check) for the
executable/output contract and restart/cancellation behavior.
