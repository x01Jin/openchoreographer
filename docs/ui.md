# Sidebar and settings dialog

## Sidebar

The sidebar shows an `AGENTS & MODELS` block with three sections. `PRIMARY` lists the host's primary agents. `WORKERS` and `REVIEWERS` list only this plugin's thirteen subagents (eight workers, five reviewers); built-in host subagents are not listed. Disabled subagents are omitted. Each row shows the agent id and its effective model, or the inherited model when no override is set.

The `PRIMARY` section also lists the running sessions and their current step position. The model column stays 15 cells wide and truncates, with the `↳ ` prefix counted inside the width.

Two switches control what is visible. The `TODO panel` switch hides the TODOS section; `todowrite` and `todoread` keep working, so the list returns intact when it is turned back on. The `Agent roster` switch hides the AGENTS & MODELS block; the RUNNING list stays. Both are stored in the plugin's settings.

The TODO header animates with a flowing label every 220 ms; with animations off the header is a solid color. Turning an animation off stops its timer.

## Settings dialog

`/choreographer` opens the dialog. It has `ANIMATIONS` and `INTERFACE` rows (the four switches above), one subagent toggle row per managed agent, a `Max parallel` row, and `PRIMARY MODELS` and `FALLBACK MODELS` sections for the thirteen subagents. The section title above the agent rows is `SUBAGENT TOGGLE`.

A primary model row with no override shows the agent's configured model or `inherit`; a fallback row with no override shows `none`.

Arrow keys move, left and right change `Max parallel` by 1, enter opens a picker or confirms, space toggles the focused subagent row on/off, and escape closes the dialog or backs out of the picker first. Click a row to select it, click its checkbox to toggle it, and use the wheel to scroll. The footer reads `↑↓ move · ←→ ±1 · enter pick · space on/off · r reset · esc close`. `r` resets whatever the row holds, including every member's override on a bulk model row.

The model picker groups models by provider. Entering a bulk row applies the choice to every agent in the group, replacing per-agent overrides. Typing filters models case-insensitive over the name, the provider, and `provider/model`; zero matches shows `no matches for "<query>"` and enter does nothing. Up and down moves and stages a model, enter confirms, escape clears the query first, then backs out.

Subagent toggles and model overrides persist in the plugin's settings storage. Disabling a subagent removes it from the live roster on the next `ctx.agent.reload()`; no agent file is moved or edited. The orchestrator prompt drops the disabled agent's rules and each worker's `Team:` line drops the id. When the server half is not running, the animation and interface toggles still apply from the TUI's own storage, the agent rows are unavailable, and the picker is read-only.
