# Models

A subagent's primary model resolves in this order: the dialog override first, else `agents.<id>.model` from the host config, else the model the agent inherits from the parent session. Dialog overrides live in the plugin's own settings storage, not in `opencode.jsonc` or the agent `.md` files. The plugin never changes a configured agent model itself.

Fallbacks are set the same way, in the `/choreographer` dialog only: per agent, or for a whole group with the `all workers` and `all reviewers` rows. There is no config option for them. A `fallback` key left in the plugin's `options` block is ignored, and setup logs one warning about it.

A model ref is `provider/model`, optionally followed by `#variant` (for example `opencode-go/deepseek-v4.1-flash`). An agent with no fallback override in the dialog has no fallbacks, and the orchestrator is excluded from fallback handling entirely.

A 429, a 402, or an error whose message names a rate limit, quota, usage limit, or free-tier limit marks that model unavailable. Availability is tracked per `provider/model`, not per agent, so one exhausted model affects every agent that uses it. The mark expires after 5 minutes, and the window doubles on each new failure up to 60 minutes. A successful spawn on a model clears its state, so the primary is used again as soon as it works.

Before a subagent is spawned the plugin picks the first model that is not marked unavailable and passes it to the call. A model supplied explicitly by the caller is left alone unless it is already marked unavailable. When no alternate is available the plugin still tries the last one rather than failing. If a spawn fails on an exhausted model, the plugin retries that one spawn once with the fallback model and no more; a failure on a model that is not exhausted propagates untouched.

That retry only covers a call that waits for the child. A background call returns its sessionID before the child runs, so a quota failure inside the child surfaces in the child session, not as a thrown spawn error, and the parent sees the sessionID. The host's own retry is switched off for an agent that has fallbacks.

The read-only `fallback_status` tool reports each managed agent's primary model, its dialog fallbacks, and any model currently in backoff, so you can tell which model a worker will use before spawning it. See [tools](tools.md) for its output shape.

An agent with no configured model inherits the parent session model. When that inherited default is a free-tier model, quota failures hit every spawn, and without a fallback there is nothing to switch to. Set a fallback before relying on that setup.
