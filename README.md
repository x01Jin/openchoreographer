# openchoreographer

A lightweight OpenCode V2 orchestrator plugin with worker and reviewer subagents that outputs quality without eating too much usage

## Install

```sh
opencode plugin add openchoreographer
```
```sh
npx openchoreographer --no-plugin
```

The first command registers the plugin. The second writes the fourteen agent definitions into `~/.config/opencode/agents/`. Restart OpenCode afterwards.

Requires OpenCode V2 (plugin API 2.1.x) and Node 22.6+ for the installer. Every flag, exit code, and upgrade path is in [docs/install.md](docs/install.md).

Do not load a local copy and the npm or GitHub package at once.

## Usage

```text
opencode run --agent orchestrator --auto "Add a retry with backoff to the upload client and run the relevant tests."
```

If `default_agent` is `"orchestrator"` in `opencode.jsonc`, new sessions use the orchestrator by default.

- `/choreographer` opens the settings dialog.
- `/review-panel` runs a strict review of the current changes. The orchestrator already runs reviewers before delegating work and after its workers edit, so use this for changes that arrived from elsewhere, such as a pull, a teammate's branch, or manual edits, when you want the same review panel without starting an orchestration run.

## Documentation

| Topic | Page | One-line summary |
| --- | --- | --- |
| What the plugin is | [docs/overview.md](docs/overview.md) | Server/TUI split, commands, agents at a glance, result clipping, state |
| Installing and upgrading | [docs/install.md](docs/install.md) | npm and clone install, every installer flag, exit codes, prune |
| The 14 agents | [docs/roster.md](docs/roster.md) | Full agent table, worker contract, scope routing, step budgets |
| How work gets delegated | [docs/orchestration.md](docs/orchestration.md) | Operating loop, effort tiers, background subagents, failure handling |
| Reviews | [docs/reviews.md](docs/reviews.md) | Diff review panel, lenses, plan-stage reviewers, findings format |
| Models and fallbacks | [docs/models.md](docs/models.md) | Primary precedence, dialog overrides, failure classes, retry ladder |
| Sidebar and settings dialog | [docs/ui.md](docs/ui.md) | Roster sections, toggles, step and model rows, picker keys |
| The diff tool | [docs/diff.md](docs/diff.md) | Parameters, output shape, Risk line, limits, CRLF handling |
| Todos and fallback status | [docs/tools.md](docs/tools.md) | todowrite, todoread, fallback_status |
| Plugin options | [docs/configuration.md](docs/configuration.md) | agent, maxReviewers, with an example |
| Measuring tokens and cost | [docs/cost.md](docs/cost.md) | V2 session stats, the fixture protocol, and the numbers to record |
| Working on the plugin | [docs/development.md](docs/development.md) | Layout, scripts, installer checks, style, id duplication |
| When something is wrong | [docs/troubleshooting.md](docs/troubleshooting.md) | Common failures and what fixes each one |

## License

MIT. See [LICENSE](LICENSE).
