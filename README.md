# openchoreographer

A read-only orchestrator, eleven specialist agents, and a collapsible agent roster for OpenCode V2.

## Install

```sh
opencode plugin add openchoreographer
npx openchoreographer --no-plugin
```

The first command registers the plugin. The second writes the eleven agent definitions into `~/.config/opencode/agents/` — OpenCode cannot create agents at runtime, so the Markdown files have to be on disk — and `--no-plugin` stops the installer from copying a second copy of the plugin into `~/.config/opencode/plugins/`. Restart OpenCode afterwards.

From a clone, or to pin a commit:

```sh
gh repo clone x01Jin/openchoreographer
cd openchoreographer
node bin/install.mjs --no-plugin
opencode plugin add github:x01Jin/openchoreographer
```

Requires OpenCode V2 (plugin API 2.1.x) and Node 22.6+ for the installer.

Flags: `--local` copies the plugin plus agents into the global config dir; `--project` installs into `<project>/.opencode/`; `--force` overwrites changed files; `--reset-steps` resets bundled step budgets on overwrite and requires `--force`; `--prune` deletes retired agent files in the target directory and requires `--force`; `--dry-run` prints what would happen and writes nothing; `--no-agents` skips agent files; `--no-deps` skips the dependency install; `--no-plugin` installs only the agent definitions and skips copying plugin files; `--version` prints the installer version. `--local` and `--project` are mutually exclusive.

The installer compares file content. Identical files report `same`. Files that differ without `--force` are skipped and listed as `stale`, except an agent file whose only difference is a preserved `steps:` budget reports `same`, is not written, and does not raise the exit code; everything else is still written, and the process exits 2 so a script can detect an incomplete upgrade. For a clone the upgrade path is `git pull && node bin/install.mjs --force`; for the npm package run `opencode plugin update`, then `npx openchoreographer --force`. `--force` keeps an existing `steps:` budget in agent files, so tuned budgets survive an upgrade; `--reset-steps` restores the bundled defaults.

Upgrading from the eighteen-agent layout copies the eleven but leaves the old `reviewer-*.md` files in `~/.config/opencode/agents/` and the stale model entries in `opencode.jsonc`. `node bin/install.mjs --force --prune` removes the retired files it knows about; the `agents` entries for the eleven removed reviewer ids must be deleted from `opencode.jsonc` by hand: reviewer-general, reviewer-oop, reviewer-functional, reviewer-procedural, reviewer-concurrent, reviewer-distributed, reviewer-data, reviewer-api, reviewer-frontend, reviewer-performance, reviewer-testing.

`--local` and `--project` run `npm install --omit=dev` in the copied plugin directory, because `tui.tsx` has runtime imports (`solid-js`, `@opentui/*`) that a copied directory cannot resolve on its own. `--no-deps` skips this, at the cost of the sidebar failing to load.

Do not load a local copy and the npm or GitHub package at once. Two copies register the commands and the sidebar twice.

## What it does

- Registers `/orchestrate` and `/review-panel`.
- The orchestrator cannot edit, write, or run shell. Every change goes through a worker subagent.
- A read-only `diff` tool is registered for the orchestrator and the reviewers, so they can verify what workers changed without shell access.
- A sidebar roster shows PRIMARY / WORKERS / REVIEWERS with each agent's model, plus running child sessions. WORKERS is every subagent that is not a reviewer, including `explore`, `tester`, and any built-in or user subagent, not only the five domain workers and the two specialists in the table.
- Delegation guidance is injected into the orchestrator's system context, and the strict review protocol lives in the two reviewer agent definitions.
- Each text part of a subagent result over 4000 characters is clipped before the orchestrator sees it: the head and the tail survive (the worker return contract puts TASK and FILES at the top, BLOCKED and RISK at the bottom) with a marker giving the dropped character count. This is a safety net for foreground subagent calls; a background child returns its sessionID immediately and the parent's copy of its report is delivered by the host.

## Agents

| id | mode | default steps | role | allowed |
| --- | --- | --- | --- | --- |
| `orchestrator` | primary | 90 | plans, delegates, verifies | read, `diff`, subagents |
| `explore` | subagent | 50 | read-only recon, returns a location map | read only |
| `backend` | subagent | 80 | services, APIs, integrations | edit + shell on assigned files |
| `frontend` | subagent | 80 | components, state, styling, accessibility | edit + shell on assigned files |
| `database` | subagent | 60 | schemas, migrations, queries | edit + shell on assigned files |
| `devops` | subagent | 60 | build, CI, containers, deploys | edit + shell on assigned files |
| `tester` | subagent | 70 | reproduces bugs, writes tests, reports results | edit + shell on assigned files |
| `designer` | subagent | 40 | UI flows, states, copy, and accessibility intent | read only |
| `writer` | subagent | 50 | README, docs, changelog, migration notes | Markdown edit + shell |
| `reviewer` | subagent | 40 | strict read-only review through one lens | `diff`, read only |
| `reviewer-security` | subagent | 35 | strict read-only security review | `diff`, read only |

The panel is one `reviewer` with a lens argument plus a conditional `reviewer-security`. The lens list (correctness, oop, functional, procedural, concurrency, distributed, data, api, frontend, performance, testing) lives in `src/shared/review.ts` and is injected as one `id — label: hint` line per lens, not copied into the agent files.

The orchestrator runs `designer` before `frontend` when a task changes a flow, state, empty/error case, or copy, pasting its states and copy into the frontend prompt. It runs `writer` after behavior and interface settle, and `writer` reports `BLOCKED` when docs need a code change.

## The diff tool

`diff` takes `mode` (`working` is uncommitted, `branch` is against the merge base, `committed` is the last commit), `base` to compare against another ref, `context` for 0-10 lines around each hunk (default 3), `path` to narrow to matching files, and `stat` for a counts-only listing without patches. Output is per-file with status and line counts, capped at 60k chars; past that it tells you to pass `path` or `base`. The orchestrator is read-only with no shell, so this is how it verifies what workers changed. Reviewers get it too and have no shell at all. An empty result returns the sentence `No changes in mode <mode>.`, and a VCS failure returns `diff unavailable: <message>` as content rather than an error. When the working tree is CRLF and the repository blobs are LF, the VCS provider reports every modified file as a full rewrite; the tool collapses `-`/`+` pairs that differ only by a trailing carriage return, recomputes each file's addition and deletion counts, and drops files that differ only in line endings, while a reordered block is not collapsed. The output is for reading, not a patch you can apply. The first line is a routing line: `Risk: <n> files, +<additions> -<deletions>. Signals: <category> (<file>) ... Lenses: <ids>.` Signals cover auth, secrets, sql, shell, and html, at most three, sanitized onto one line; the suggested lenses are always correctness, plus security when any signal fires and data when sql fires. That is a floor: path traversal, SSRF, and deserialization stay judgment calls for the reviewers. Pass `stat: true` for a counts-only listing with the same `Risk:` header followed by one `<status> <file> +<additions> -<deletions>` line per file and no patches; the 60k truncation still applies and metadata gains `stat: true`.

## Delegation

Independent work runs as background subagents; each call returns a sessionID immediately, and passing it back continues that same child. Only one writer touches a file set at a time unless the sets are disjoint, and `maxParallel` is a prompt-level hint that enforces nothing. The orchestrator is told to verify a finished batch with a single `diff` read after the batch, narrowing with `path` when it spans many files, rather than re-reading after every child. A role that fails twice is reported as unavailable, with the model and the failure; its work is never reassigned to a different role. A worker that receives a task outside its role returns `BLOCKED: outside scope; belongs to <role>`; the orchestrator sends that task to the named role instead of attempting it. An override attempt is refused and reported, and the task is not retried.

Effort is tiered, and a tier is a ceiling, not a target: the orchestrator picks the tier before spawning anything and re-checks it against the `Risk:` line the `diff` tool returns. Tier 0 (no file change) spawns nothing; Tier 1 (one mechanical file) is one worker with no reviewer; Tier 2 (two to five files or new tests) adds the correctness lens only; Tier 3 (more than five files or any risk signal) adds correctness plus security, plus `tester` when behavior changed.

When `explore` ran, its map is pasted into child prompts so children do not rediscover the tree. MCP tools are routed by agent (code-intelligence, `context7`, browser), while MCP tools that change external state belong to workers, never to the read-only orchestrator.

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

## Model fallback

A subagent can be switched to a fallback model when its primary model is rate limited or out of quota. The orchestrator is excluded: it always runs the model you pick for the session.

Primary models stay where they already are, `agents.<id>.model` in `opencode.jsonc`. The plugin does not duplicate them. `fallback` is a plugin option keyed by agent id, and each value is an ordered list of alternates:

```jsonc
"options": {
  "maxParallel": 4,
  "fallback": {
    "backend": ["opencode-go/muse-spark-1.3-contributor"],
    "reviewer": ["opencode-go/muse-spark-1.3-contributor", "opencode-go/another-model"]
  }
}
```

Valid keys are the managed subagents: `explore`, `backend`, `frontend`, `database`, `devops`, `tester`, `designer`, `writer`, `reviewer`, `reviewer-security`. Any other key is dropped with a warning. A model string is `provider/model`, optionally `provider/model#variant`; an invalid entry is dropped with a warning, and an empty list disables fallback for that agent.

A 429, a 402, or an error whose message names a rate limit, quota, usage limit, or free-tier limit marks that model unavailable. Availability is tracked per `provider/model`, not per agent, so one exhausted model affects every agent that uses it.

Before a subagent is spawned the plugin picks the first configured model that is not marked unavailable and passes it to the subagent call. When no alternate is available it still tries the last one rather than failing. If a spawn fails on an exhausted model, the plugin retries that one spawn once with the fallback model and no more; a failure on a model that is not exhausted propagates untouched. The host's own retry is switched off for an agent that has fallbacks.

A spawn that fails after the working tree changed is not retried on a fallback model, because a retry would start a fresh child session against the files the failed one already wrote; the error names up to five changed files. At setup, when a fallback model's context window is smaller than its primary's, the plugin logs a warning naming both limits, and those limits are advisory: they never block setup.

A mark expires after 5 minutes, and the window doubles on each new failure up to 60 minutes. A successful spawn on a model clears its state immediately, so the primary is used again as soon as it works.

The read-only `fallback_status` tool reports each managed agent's primary model, its configured fallbacks, and any model currently in backoff, so you can tell which model a worker will use before spawning it.

Agents without a `fallback` entry are never touched, and the orchestrator is never affected.

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
- `fallback`: per-agent ordered fallback models for subagents, default empty. See [Model fallback](#model-fallback).

## Settings

`/choreographer` opens a settings dialog.

- `TODO animations`: the colour cycle on in-progress todo rows.
- `RUNNING animations`: the flowing RUNNING label.
- `TODO panel`: shows or hides the TODOS section in the sidebar.
- `Agent roster`: shows or hides the AGENTS & MODELS block (PRIMARY, WORKERS, REVIEWERS). The RUNNING list stays visible while subagents run, even with the roster hidden.
- One row per managed agent with its step budget.

Arrow keys move, left and right change a step budget by 5, enter toggles an animation or a switch, `r` resets a step budget to its default, and escape closes. Click a row to select it, click `−` or `+` to change a budget, and use the wheel to scroll.

The dialog writes `steps:` into the agent definition file (`~/.config/opencode/agents/<id>.md`, or `.opencode/agents` when the project has one), and the installer keeps the value across upgrades unless `--reset-steps` is passed. The host reloads the agent when that file changes. `STEP_DEFAULTS` in `src/shared/agents.ts` is the reset target, and no step value is stored in the plugin's own settings. A budget set in the dialog is written to the file, the default in `STEP_DEFAULTS` is what `r` writes back, and the panel and the file therefore always show the same number. Values are clamped to 1-2000.

Turning an animation off stops its timer, including the 60ms repaint loop the todo animation drove.

The `TODO panel` switch only hides the sidebar section; `todowrite` and `todoread` keep working, so the list returns intact when it is turned back on.

The dialog talks to the plugin's server entry over RPC. If that entry is not running, the animation and interface toggles apply from the TUI's own storage and the agent rows are unavailable.

## Usage

```text
opencode run --agent orchestrator --auto "Add a retry with backoff to the upload client and run the relevant tests."
```

If `default_agent` is `"orchestrator"` in `opencode.jsonc`, new sessions use the orchestrator by default. Use `/orchestrate` to switch an existing session, `/review-panel` for a strict review of the current changes, and `/choreographer` for the settings dialog.

## Development

```sh
npm install
npx tsc --noEmit
npm run dry-run
```

`bin/install.mjs` is checked by tsc through `allowJs`/`checkJs`. `@opentui/core` declares `node >= 26.4` for its own runtime, so `EBADENGINE` on install is harmless here. `index.ts` (server) and `tui.tsx` (TUI) are composition roots; the implementation lives under `src/shared` (pure helpers), `src/server` (tools, hooks, commands), and `src/tui` (components). The installer copies the root files plus `src/` recursively. `npm test` runs the `node:test` suites in `tests/` through `tsx` (a dev-only dependency, not shipped), and `npx tsc --noEmit` still typechecks the plugin and the tests.

## Troubleshooting

- Missing agent definitions: the plugin logs a warning naming the unregistered agents and still loads. Re-run `node bin/install.mjs --force`, then restart OpenCode.
- Sidebar empty: the TUI half failed to resolve `solid-js`. Re-run the installer without `--no-deps`.
- Commands registered twice: two copies of the plugin are loaded. Remove one.
- Diff counts that look like whole files: the VCS provider is comparing a CRLF working tree against LF blobs. The tool collapses that churn; if the counts still look wrong, check `git ls-files --eol` and the repository's line-ending configuration.
