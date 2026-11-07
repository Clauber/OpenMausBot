# Local call terms

- The listener is the fast conversational model, Haiku by default. It keeps call history, speaks, and proposes a task for the full agent.
- The gate is Jev. It decides whether a new task needs the full agent at a probability of at least 0.6. It performs no work itself.
- A background job runs the copied bot's own agent through `think`. Its lifetime belongs to the call, so a new user turn cannot cancel it.
- A speech context is one ElevenLabs WebSocket `context_id` per spoken reply. Interrupting it preserves the call's connection and background work.
