# Bot-scoped chat panels

Base: ffe456fd2b52b4f23e350f3f8984057a620d50e4.

Chat header thread dropdown lists attention only for its opened bot. Global
sidebar activity remains cross-bot. Keep quiet history and thread actions.

Bot details panel remembers open/closed, chosen section and accordion expansion
by bot ID. Switching bots restores each bot atomically. Thread changes within
one bot preserve settings. Reload restores choices after roster hydration.
Closing a panel preserves its chosen section and collapsed/expanded choice.
New bots start closed at Overview with collapsed accordion. No bot or a room
has no bot panel. Deleted bots lose remembered entries. Ignore legacy global
section values rather than assigning one bot's choice to all bots. Malformed
or inaccessible storage must not interrupt UI or in-session memory.

Do not alter Screen/browser state, global navigation, bot data or live service.
Use isolated fixture only. No deployment, restart, merge, rebase or force push.

Gates: focused failing regression committed before implementation, focused
passing tests, tree typecheck, changed-file lint, quality review, isolated
browser workflow and screenshots or explicit unavailable-browser handoff.
