# Activate conversation browser profiles on the next turn

Browser tools hold a capability bound to one conversation, generation and browser session. Profile selection records a conversation request and activates it on the next turn, preserving the current binding instead of rotating capabilities during in-flight actions. Screen keeps the last verified viewer profile under fresh authorization while that request is pending; this preserves idle viewing without treating a saved preference as an active tool binding.
