# openchoreographer

A read-only orchestrator, nine specialist agents, and a collapsible agent roster for OpenCode V2.

## Install

```sh
opencode plugin add openchoreographer
npx openchoreographer --no-plugin
```

The first command registers the plugin. The second writes the nine agent definitions into `~/.config/opencode/agents/` — OpenCode cannot create agents at runtime, so the Markdown files have to be on disk — and `--no-plugin` stops the installer from copying a second copy of the plugin into `~/.config/opencode/plugins/`. Restart OpenCode afterwards.

From a clone, or to pin a commit:

```sh
gh repo clone x01Jin/openchoreographer
cd openchoreographer
node bin/install.mjs --no-plugin
opencode plugin add github:x01Jin/openchoreographer
```

Requires OpenCode V2 (plugin API 2.1.x) and Node 22.6+ for the installer.

Flags: `--local` copies the plugin plus agents into the global config dir; `--project` installs into `<project>/.opencode/`; `--force` overwrites changed files; `--prune` deletes retired agent files in the target directory and requires `--force`; `--dry-run` prints what would happen and writes nothing; `--no-agents` skips agent files; `--no-deps` skips the dependency install; `--no-plugin` installs only the agent definitions and skips copying plugin files; `--version` prints the installer version. `--local` and `--project` are mutually exclusive.

The installer compares file content. Identical files report `same`. Files that differ without `--force` are skipped and listed as `stale`; everything else is still written, and the process exits 2 so a script can detect an incomplete upgrade. For a clone the upgrade path is `git pull && node bin/install.mjs --force`; for the npm package run `opencode plugin update`, then `npx openchoreographer --force`.

Upgrading from the eighteen-agent layout copies the nine but leaves the old `reviewer-*.md` files in `~/.config/opencode/agents/` and the stale model entries in `opencode.jsonc`. `node bin/install.mjs --force --prune` removes the retired files it knows about; the `agents` entries for the eleven removed reviewer ids must be deleted from `opencode.jsonc` by hand: reviewer-general, reviewer-oop, reviewer-functional, reviewer-procedural, reviewer-concurrent, reviewer-distributed, reviewer-data, reviewer-api, reviewer-frontend, reviewer-performance, reviewer-testing.

`--local` and `--project` run `npm install --omit=dev` in the copied plugin directory, because `tui.tsx` has runtime imports (`solid-js`, `@opentui/*`) that a copied directory cannot resolve on its own. `--no-deps` skips this, at the cost of the sidebar failing to load.

Do not load a local copy and the npm or GitHub package at once. Two copies register the commands and the sidebar twice.

## What it does

- Registers `/orchestrate` and `/review-panel`.
- The orchestrator cannot edit, write, or run shell. Every change goes through a worker subagent.
- A read-only `diff` tool is registered for the orchestrator and the reviewers, so they can verify what workers changed without shell access.
- A sidebar roster shows PRIMARY / WORKERS / REVIEWERS with each agent's model, plus running child sessions. WORKERS is every subagent that is not a reviewer, including `explore`, `tester`, and any built-in or user subagent, not only the four domain workers in the table.
- Delegation guidance is injected into the orchestrator's system context, and a strict review protocol is injected into each reviewer agent.

## Agents

| id | mode | steps | role | allowed |
| --- | --- | --- | --- | --- |
| `orchestrator` | primary | 60 | plans, delegates, verifies | read, `diff`, subagents |
| `explore` | subagent | 10 | read-only recon, returns a location map | read only |
| `backend` | subagent | 25 | services, APIs, integrations | edit + shell on assigned files |
| `frontend` | subagent | 25 | components, state, styling, accessibility | edit + shell on assigned files |
| `database` | subagent | 25 | schemas, migrations, queries | edit + shell on assigned files |
| `devops` | subagent | 25 | build, CI, containers, deploys | edit + shell on assigned files |
| `tester` | subagent | 20 | reproduces bugs, writes tests, reports results | edit + shell on assigned files |
| `reviewer` | subagent | 15 | strict read-only review through one lens | `diff`, read only |
| `reviewer-security` | subagent | 12 | strict read-only security review | `diff`, read only |

The panel is one `reviewer` with a lens argument plus a conditional `reviewer-security`. The lens list (correctness, oop, functional, procedural, concurrency, distributed, data, api, frontend, performance, testing) lives in `shared.ts` and is injected, not copied into the agent files.

## The diff tool

`diff` takes `mode` (`working` is uncommitted, `branch` is against the merge base, `committed` is the last commit), `base` to compare against another ref, `context` for 0-10 lines around each hunk (default 3), and `path` to narrow to matching files. Output is per-file with status and line counts, capped at 60k chars; past that it tells you to pass `path` or `base`. The orchestrator is read-only with no shell, so this is how it verifies what workers changed. Reviewers get it too and have no shell at all. An empty result returns the sentence `No changes in mode <mode>.`, and a VCS failure returns `diff unavailable: <message>` as content rather than an error.

## Delegation

Independent work runs as background subagents; each call returns a sessionID immediately, and passing it back continues that same child. Only one writer touches a file set at a time unless the sets are disjoint, and `maxParallel` is a prompt-level hint that enforces nothing.

## Review panel

`/review-panel` builds a brief: always `correctness` plus at most `maxReviewers - 1` further lenses, with `reviewer-security` added when the change touches auth, input handling, secrets, deserialization, SSRF, paths, HTML output, or SQL/shell construction. Findings are one line each (`file:line — defect — fix`), at most 6 (4 for security), ending with a `VERDICT` line. Dedupe on identical file:line:issue keeps the more specific lens' finding, and unverified claims go under Unverified, never as findings. A reviewer that returns no `VERDICT` line counts as failed and is rerun once with a narrower file list.

## Models

Judgment agents are worth a stronger model: `orchestrator`, `reviewer`, `reviewer-security`. `explore`, the four workers, and `tester` are mechanical and run fine on cheaper ones.

```jsonc
{
  "agents": {
    "orchestrator": { "model": "opencode-go/deepseek-v4.1-flash" },
    "reviewer": { "model": "opencode-go/deepseek-v4.1-flash" },
    "reviewer-security": { "model": "opencode-go/deepseek-v4.1-flash" }
  }
}
```

Use `provider/model`, optionally followed by `#variant`. Agents without an explicit model inherit the parent session model. The plugin does not map models.

## Configuration

```jsonc
{
  "plugins": [
    {
      "package": "openchoreographer",
      "options": {
        "agent": "orchestrator",
        "maxParallel": 4,
        "maxReviewers": 2
      }
    }
  ]
}
```

- `agent`: ID of the primary orchestrator agent.
- `maxParallel`: background subagents the orchestrator is told to run at once, 1-8, default 4.
- `maxReviewers`: reviewer calls per panel including correctness, 1-4, default 2. The cap covers `reviewer` lens calls only; `reviewer-security` is additional when its trigger fires. `1` means the correctness lens only.

## Usage

```text
opencode run --agent orchestrator --auto "Add a retry with backoff to the upload client and run the relevant tests."
```

If `default_agent` is `"orchestrator"` in `opencode.jsonc`, new sessions use the orchestrator by default. Use `/orchestrate` to switch an existing session, `/review-panel` for a strict review of the current changes.

## Development

```sh
npm install
npx tsc --noEmit
npm run dry-run
```

`bin/install.mjs` is checked by tsc through `allowJs`/`checkJs`. `@opentui/core` declares `node >= 26.4` for its own runtime, so `EBADENGINE` on install is harmless here. There is no test runner yet; `tsc` plus the installer dry-run plus live probes are the check.

## Troubleshooting

- Missing agent definitions: the plugin logs a warning naming the unregistered agents and still loads. Re-run `node bin/install.mjs --force`, then restart OpenCode.
- Sidebar empty: the TUI half failed to resolve `solid-js`. Re-run the installer without `--no-deps`.
- Commands registered twice: two copies of the plugin are loaded. Remove one.
