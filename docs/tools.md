# Other tools

`todowrite` replaces the session's todo list and returns per-status counts as JSON. `todoread` returns the session's todo list as JSON, or an empty list when unset. Both work on the current session only.

The list lives in the session's metadata under `openchoreographer.todos`. Each item needs a non-empty `content` (at most 500 characters) and a `status` of `pending`, `in_progress`, `completed`, or `cancelled`; an optional `priority` is one of `high`, `medium`, or `low`. An `id` is generated when omitted. A list holds at most 200 items.

`fallback_status` takes no input and reports each managed agent's primary model, its dialog fallbacks, and whether any model is down or degraded. It returns JSON of the form `{"agents": [{"agent": "<id>", "primary": "<ref>" | null, "fallbacks": ["<ref>"], "degraded": <bool>, "down": [{"model": "<ref>", "reason": "quota" | "retries", "waitMs": <n>}]}]}`. On failure it returns `fallback status unavailable: <message>`.

For the read-only change viewer, see [diff](diff.md).
