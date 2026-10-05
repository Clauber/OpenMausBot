# Legion implementation lessons

## LEGION-15: self-update

- A detached updater process can still die with the old systemd service's
  cgroup. Copy the bundled worker outside the installation and run it in an
  independent transient user unit before restarting the server. If launch
  acknowledgment is uncertain, retain the lock and job inputs.
- Node strip-only mode rejects TypeScript constructor parameter properties.
  The fixture server must import the same sources the packaged build uses.
- npm rejects using one path as both userconfig and globalconfig. Use distinct
  empty files and a private offline cache for bundled vendor-tgz installs.
- Vite merges configured proxy keys in order; an inherited `/api` proxy can
  swallow a more specific updater fixture proxy. Use an explicit preview config
  and assert the installed version through the actual Settings panel.

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
