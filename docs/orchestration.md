# Orchestration

The orchestrator runs a loop: restate the goal, inspect what the task needs, split the work into tasks with clear file boundaries, delegate each to its owning role, verify the diff, and report with evidence. It reads with read, glob, grep, webfetch, websearch, and the [diff](diff.md) tool. It changes files only through workers.

Delegation uses the built-in `subagent` tool with `agent`, a short `description`, and a complete `prompt` stating the goal, files, constraints, acceptance check, and return format. Independent work uses `background: true`; the child sessionID is kept for follow-ups. One writer owns a file set at a time, and disjoint sets are named explicitly when two workers run together.

Effort is tiered, and a tier is a ceiling. The orchestrator picks the tier before spawning and checks it against the `Risk:` line from the diff tool.

- Tier 0, no file change: read, glob, grep, answer. Spawn nothing.
- Tier 1, one mechanical file: one worker, no reviewer. Read the diff yourself.
- Tier 2, two to five files or new tests: workers, then the correctness lens.
- Tier 3, over five files or any `Risk:` signal: workers, correctness lens, `tester` when behavior changed, and `reviewer-security` only when its triggers match.

A worker that fails is retried once in the same role with a narrower task. A second failure stops the task and is reported with the failure and model. Work is never handed to a different role. `BLOCKED: outside <role> scope; belongs to <role>` is a scope handoff, sent once to the named role. An override refusal stops the task with no retry.

When `explore` ran, its map is pasted verbatim into child prompts. MCP tools are routed by agent: code intelligence for call paths, `context7` for library APIs, a browser for UI behavior code cannot confirm. MCP tools that change external state belong to the owning worker, never to the orchestrator.

Results are clipped. Each text part of a foreground subagent result over 3000 characters keeps its head and tail with the dropped count. A background completion notice is clipped at 2000 characters, with the full text kept in the child session. Shell output is capped at 6000 characters across text parts. A subagent report that carries a real `BLOCKED`, `RISK`, or `NOT DONE` line, or a credential, is not clipped.

The orchestrator verifies with the diff after each task, or once per batch. It passes `context: 0` unless surrounding code is needed, and reads a file directly only when the diff is ambiguous. No claim is accepted without evidence.
