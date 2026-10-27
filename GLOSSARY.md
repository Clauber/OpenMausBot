# Glossary

| Term | Meaning |
| --- | --- |
| Host CLI | Shell commands on the machine running the LEGION server, starting in the bot and conversation's task workspace. |
| Desktop surface | The screen selected through Works on. Browser selection keeps host CLI available. Off disables host CLI. |
| Local VM CLI | Shell commands inside the attached Local VM. This is a different execution target from the LEGION host. |
| Browser profile | A configured browser identity, the bot's own browser, or a temporary guest browser. Named profiles can share logins within the same audience. |
| Requested browser profile | The durable choice for one conversation's next turn. Selecting it does not change the current turn or the bot's default. |
| Mounted browser binding | The profile and session attached to one active thread generation. Pending selection keeps this binding unchanged. |
| Viewer profile | The active mounted profile, otherwise the last verified mounted profile, otherwise the bot's default. Viewing does not activate a requested profile. |
