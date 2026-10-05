# Legion implementation lessons

## LEGION-9: approval gates

- Native CLI permission modes can approve tools without emitting a harness
  request. Changing the mode globally breaks unmatched Auto/Edits behavior
  and still does not guarantee all native tools are observable. Enforce
  harness dispatch separately and document that provider boundary.
- Use advertised MCP identities for exact rules. Management tools such as
  `propose_routine_action` express deletion in arguments; preserve their name
  and classify the validated action separately.
- Card responders share routing. A proposal-specific responder must verify
  its card type before claiming an effect; otherwise it consumes a native
  card's authorization and the first Allow looks like a replay. Exercise both
  bot-level and thread-level response routes in fixtures.
- Connector batch keys must be claimed atomically, and duplicated children
  refused before deduplicating outer/child aliases. Test simultaneous HTTP
  requests, not only a sequential retry.
- Adjacent settings components need distinct React keys. A rules card keyed
  identically to outbound settings duplicated on SSE updates. Browser save,
  reopen and screenshot checks caught what typechecking could not.
