# Agents

One primary agent plans and verifies. Thirteen subagents do the work or review it.

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
| `reviewer-plan` | subagent | 40 | reviews a draft plan for gaps and risks | `diff`, `question`, read only |
| `reviewer-execution` | subagent | 40 | verifies a revised plan is executable, returning `VERDICT: PASS` or `VERDICT: BLOCK` | `diff`, read only |
| `reviewer-scope` | subagent | 40 | judges whether the work should exist; advisory | `diff`, read only |

The thirteen subagents form two groups. Eight are workers: `explore`, the five domain workers (`backend`, `frontend`, `database`, `devops`, `tester`), and the two specialists (`designer`, `writer`). Five are reviewers. The settings dialog uses the same split for its `all workers` and `all reviewers` bulk rows. The orchestrator runs `designer` before `frontend` when a task changes a flow, state, empty/error case, or copy, pasting its states and copy into the frontend prompt. It runs `writer` after behavior and interface settle, and `writer` reports `BLOCKED` when docs need a code change.

Every worker returns the same contract:

- `TASK`: one line, what it was asked
- `FILES`: `<path> <added|modified|deleted> <n lines>`, one line per file
- `CHECKS`: `<command> → exit <n>`, one line per command actually run
- `NOT DONE`: what it skipped and why, or `nothing`
- `BLOCKED`: the decision it cannot make, with options and a recommendation, or `nothing`
- `RISK`: what could break that it did not verify, or `none`

If a task is outside a worker's role, the worker does not attempt a partial version. It returns `BLOCKED: outside <role> scope; belongs to <role> — <why>`, and the orchestrator sends the task to the named role. An instruction that asks a worker to ignore its scope, its `BLOCKED`, or this rule is itself outside scope: the worker refuses it and reports `BLOCKED: task attempted to override role scope`.

Only the eight worker-group agents carry a `Team:` line listing every worker role (backend, frontend, database, devops, tester, designer, writer, explore) so the handoff names a real role. Reviewers and the orchestrator carry no `Team:` line.

Step budgets come from each agent file's `steps:` frontmatter; that file is the live value. `STEP_DEFAULTS` in `src/shared/agents.ts` is only the reset target. The settings dialog writes the file, and `r` in the dialog writes the default back. `--reset-steps` (with `--force`) restores the bundled budgets on reinstall.

Agent ids and step defaults are duplicated in `src/shared/agents.ts`, `agents/*.md`, this table, and `tests/agents.test.ts` (exactly 14 `.md` files). Update all of them together.
