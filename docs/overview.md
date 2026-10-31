# Overview

For OpenCode V2, `openchoreographer` provides one primary orchestrator and thirteen subagents. The orchestrator plans each task, delegates every edit to a worker, and accepts only what the diff confirms; it never edits files or runs shell itself.

The plugin has two halves that talk only through RPC (`src/shared/rpc.ts`). `index.ts` is the server composition root: it registers tools, hooks, commands, and agents. `src/tui/tui.js` (compiled from `src/tui/tui.tsx`) is the TUI composition root: it renders the sidebar and the settings dialog. A settings field must be added on both sides and in the RPC schemas or it is silently dropped.

There is one plugin command plus a settings shortcut. `/review-panel` switches to the orchestrator and runs a strict review of the current changes. `/choreographer` opens the settings dialog (registered as a TUI keymap slash, not a plugin command).

The roster is one primary agent and thirteen subagents. The orchestrator (`mode: primary`) plans, delegates, and verifies. Eight worker-group agents do the work: `explore` (read-only recon), five domain workers, `designer`, and `writer`. Five reviewers are read-only. See [roster](roster.md) for the full table.

Subagent results are clipped before the orchestrator sees them. A foreground result over 3000 characters keeps its head and tail with a marker giving the dropped character count, applied per text part. The worker return contract puts TASK and FILES at the top and the verdict at the bottom.

State lives in two places. Model overrides, fallbacks, and UI settings live in the plugin's settings storage. Todo lists live in the current session's metadata under `openchoreographer.todos`. The TODO panel is off by default.
