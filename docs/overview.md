# Overview

`openchoreographer` is a read-only orchestrator plus thirteen specialist subagents and a collapsible agent roster for OpenCode V2. The orchestrator plans work, delegates every change to a worker, and verifies the result in the diff. It never edits files or runs shell commands itself.

The plugin has two halves that talk only through RPC (`src/shared/rpc.ts`). `index.ts` is the server composition root: it registers tools, hooks, and commands. `tui.tsx` is the TUI composition root: it renders the sidebar and the settings dialog. A settings field must be added on both sides and in the RPC schemas or it is silently dropped.

There are two plugin commands and one settings shortcut. `/orchestrate` switches to the orchestrator and starts a delegated task. `/review-panel` switches to the orchestrator and runs a strict review of the current changes. `/choreographer` opens the settings dialog (registered as a TUI keymap slash, not a plugin command).

The roster is one primary agent and thirteen subagents. The orchestrator (`mode: primary`) plans, delegates, and verifies. Eight worker-group agents do the work: `explore` (read-only recon), five domain workers (`backend`, `frontend`, `database`, `devops`, `tester`), and two specialists (`designer`, read-only; `writer`, docs only). Five reviewers (`reviewer`, `reviewer-security`, `reviewer-plan`, `reviewer-execution`, `reviewer-scope`) are read-only. See [roster](roster.md) for the full table.

A foreground subagent result is clipped before the orchestrator sees it. Each text part over 4000 characters keeps its head and tail with a marker giving the dropped character count. The worker return contract puts TASK and FILES at the top and BLOCKED and RISK at the bottom, so both ends survive. A background child returns its sessionID immediately and the host delivers the parent's copy of its report, so clipping only applies to foreground calls.

State lives in three places. Step budgets live in each agent definition file's `steps:` frontmatter. Model overrides and fallbacks live in the plugin's own settings storage. Todo lists live in the current session's metadata under `openchoreographer.todos`.
