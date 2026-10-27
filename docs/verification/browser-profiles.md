# Conversation browser profiles

Use an isolated fixture from [the verification guide](README.md). Never use a real account, shared profile or another turn's browser lock for this check.

The Screen profile chooser requests a browser for its conversation. Bot settings continue to manage the bot default and profile definitions. Native mounted tools expose the same conversation choice through `browser_profiles_list` and `browser_profile_select`.

## Activation contract

A selection applies on the next turn. The current turn keeps its mounted browser capability. Results distinguish the requested choice, active binding and viewer profile. A ready binding confirms the mounted session identity; it does not prove that Chrome launched or a page loaded.

Idle Screen viewing uses the last verified mounted profile, with fresh viewer authorization and the conversation's current audience. If the conversation has never mounted a browser, it uses the bot default. Viewer reconnect does not activate a pending request. Stored profile choices contain no capability, credential or resolved session.

Own browser, temporary browser and existing configured built-in profiles are selectable. My Chrome attachment aliases are unsupported by the new conversation selector because they share one physical browser and cannot prove separate account/occupancy isolation. Existing My Chrome bot-default administration is unchanged. Invalid, removed, unavailable or occupied targets produce explicit errors. Selection never starts the current browser, takes another holder's lock or releases a claim. Browser actions retain normal resource ownership checks, and activation rechecks availability.

## Mounted fixture path

1. Configure two synthetic profiles in a disposable workspace. Create a browser-enabled fixture bot and two conversations.
2. Start a fake-model turn and obtain its browser MCP configuration from the fixture dump. Treat its token as private fixture data.
3. Call the actual mounted MCP endpoint's tools list. Both profile tools appear once.
4. List profiles, select another configured profile, then list again. Active identity stays unchanged; requested identity changes and state says pending. The bot default and sibling conversation stay unchanged.
5. End the turn. Its old capability must fail. Start another turn and list through its fresh capability. Active identity must match the requested profile.
6. Repeat with own and temporary choices. Reload/restart the isolated fixture and confirm conversation preferences persist.
7. Reject an unknown or removed profile, a stale capability, denied browser permission and a mismatched conversation. Known target occupancy must not mutate preferences or either lock. An occupied current browser must not block listing or selecting another target.

## Screen path

Open the same fixture in an authorized mounted browser. In Screen, open Profiles, select a configured profile and confirm pending text says it applies next turn. The displayed browser and signed-in-sites metadata must retain the current viewer profile and audience. Reload and switch conversations; each restores its own request. After the next turn binds, verify the displayed and active identities agree. Ending that turn must preserve idle viewing.

Capture the real chooser with active/requested state, then the confirmed next-turn state. Record URL, fixture bot/conversation, source SHA and screenshot paths. A mocked frame or passing component test does not satisfy this browser gate. If mounted browser access is unavailable, retain one authoritative preview and leave acceptance open.

The original bot-scoped dropdown and bot details persistence remain separately covered by PR #18's focused tests and preview. No merge or production deployment is part of this fixture recipe.
