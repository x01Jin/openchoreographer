# Sidebar and settings dialog

## Sidebar

The sidebar shows an `AGENTS & MODELS` block with three sections. `PRIMARY` lists the host's primary agents. `WORKERS` and `REVIEWERS` list only this plugin's thirteen subagents (eight workers, five reviewers); built-in host subagents are not listed. Each row shows the agent name and its active model. Below the roster, `RUNNING` lists running child sessions of the current session, and `TODOS` lists the session's todo items with a done/total count.

Two switches control what is visible. The `TODO panel` switch hides the TODOS section; `todowrite` and `todoread` keep working, so the list returns intact when it is turned back on. The `Agent roster` switch hides the AGENTS & MODELS block; the RUNNING list stays visible while subagents run, even with the roster hidden. Two more switches control animation: `TODO animations` (the colour cycle on in-progress todo rows) and `RUNNING animations` (the flowing RUNNING label). Turning an animation off stops its timer.

## Settings dialog

`/choreographer` opens the dialog. It has `ANIMATIONS` and `INTERFACE` rows (the four switches above), one `AGENT STEPS` row per managed agent with its step budget, and `PRIMARY MODELS` and `FALLBACK MODELS` sections for the thirteen subagents. Each model section groups its rows under `WORKERS` and `REVIEWERS` subheaders with one bulk row per group (`all workers`, `all reviewers`). A bulk row shows the shared model name when its members agree and `custom` when they differ. A primary row with no override shows the agent's configured model or `inherit`; a fallback row with no override shows `none`.

Arrow keys move, left and right change a step budget by 5, enter opens a picker or confirms, space confirms, and escape closes the dialog (or backs out of the picker first). Click a row to select it, click `−` or `+` to change a budget, and use the wheel to scroll. `r` resets whatever the row holds: a step budget back to its default, a primary or fallback row's override cleared, or every member's override cleared on a bulk row. The in-dialog model picker groups models by provider; entering a bulk row applies the choice to every agent in the group at once, replacing per-agent overrides.

Step budgets persist to the agent definition file (`~/.config/opencode/agents/<id>.md`, or `.opencode/agents` when the project has one) and the host reloads the agent when that file changes. Model overrides persist to the plugin's own settings storage and write no file. Values are clamped to 1-2000 steps. When the server half is not running, the animation and interface toggles still apply from the TUI's own storage, the agent rows are unavailable, and the picker is read-only.
