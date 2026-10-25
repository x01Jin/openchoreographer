# Cost measurement

Measure token and cost changes instead of arguing about them.
Use this for any change to prompts, spawn policy, output budgets, or model routing.

Tool: the host's V2 native telemetry, not a plugin. `session.stats`
covers sessions, subagents, prompts, steps, tokens, cost, per-model
usage, and tools. `session.step.ended` gives per-step input, output,
reasoning, cache read and write, and cost. The TUI's
`data.session.cost(sessionID)` and `session.family(sessionID)` give
a per-run view.

Do not install TokenScope here: version 1.8.1 is V1-only and does not
load on this V2 host. If a V2-compatible release appears, pin it
and revisit.

Protocol: freeze the model, cache settings, repo state, and prompt first.

1. Two-file mechanical change with a test.
2. Tester-heavy change whose log exceeds 8,000 characters.
3. `/review-panel` on a five-file diff.

Run each fixture three times before and three times after the change.
Record input, output, reasoning, cache read and write, cost, steps,
subagents, tool usage, findings, and wall-clock time.

Acceptance: tokens or cost per completed task goes down, cache read
share is not worse, and no true finding is lost. Revert when flat.
Put the numbers in the change report or a scratch note.

Why cache share matters: a cache read costs about 2% of input price on
`opencode-go/deepseek-v4.1-flash` and about 10% on Anthropic, so pruning
or reordering context can cost more in cache rewrites than it saves.
Current budgets: 4,000 chars per foreground text part, 2,500 for a
background completion copy, 8,000 total for shell/bash across text parts.
