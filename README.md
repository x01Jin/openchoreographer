# openchoreographer

Ships a read-only orchestrator agent, worker and reviewer agents, two commands, and a sidebar roster for OpenCode V2.

## Install

Primary install (private GitHub repo):

```sh
opencode plugin add github:x01Jin/openchoreographer
gh repo clone x01Jin/openchoreographer
cd openchoreographer
node bin/install.mjs
```

For a private repo this uses your existing Git credentials. If that fails, use `opencode plugin add git+ssh://git@github.com/x01Jin/openchoreographer.git` with SSH access configured.

`opencode plugin add` installs the plugin. The clone plus `node bin/install.mjs` installs the 18 agent files without copying the plugin again.

Do not load both a local copy and the GitHub package. Two copies register the commands and sidebar twice. Remove the local entry from `plugins` before switching.

This places the 18 bundled agent definitions (`orchestrator.md`, `frontend.md`, `backend.md`, `database.md`, `devops.md`, `tester.md`, and the 12 `reviewer-*.md` files) into `~/.config/opencode/agents/`. Then restart OpenCode.

Offline/local alternative from a clone:

```sh
gh repo clone x01Jin/openchoreographer
cd openchoreographer
node bin/install.mjs --local
```

`--local` copies both the plugin and the agents, so do not combine it with `opencode plugin add`.

Run `node bin/install.mjs ...` from the `openchoreographer/` package directory, or pass the absolute path to the script. This copies the plugin files (`index.ts`, `tui.tsx`, `package.json`, `README.md`, `LICENSE`, `agents/`, `bin/install.mjs`) into `~/.config/opencode/plugins/openchoreographer/` and installs the agents globally. No registry access needed after the clone.

Project-local:

```sh
gh repo clone x01Jin/openchoreographer
cd openchoreographer
node bin/install.mjs --project
```

This copies the plugin files into `<project>/.opencode/plugins/openchoreographer/` and the agents into `<project>/.opencode/agents/`.

Manual install: copy `agents/*.md` into `~/.config/opencode/agents/` and add `"openchoreographer"` to `plugins` in `opencode.jsonc`, or copy the whole package folder to `~/.config/opencode/plugins/openchoreographer/`.

The installer is needed because OpenCode cannot create agents at runtime, so the Markdown definitions have to be placed on disk.

Installer flags: `--local`, `--project` (implies local plugin copy; `--local` and `--project` are mutually exclusive), `--force` (overwrite existing files without a backup, otherwise existing files are skipped), `--dry-run` (print planned paths, write nothing), `--no-agents` (skips writing agent files, including the plugin's bundled copy). `init` may be passed as a positional argument and is ignored, so `node bin/install.mjs init` works. Set `OPENCODE_CONFIG_DIR` to an absolute path to override the global config directory (`~/.config/opencode` by default).

Publishing:

npm publishing is optional; the package name is `openchoreographer`.

```sh
npm publish --access public
```

Pin `@opencode/plugin` to the OpenCode version you target before publishing, instead of `latest`.

## What it does

- Registers `/orchestrate` and `/review-panel` commands.
- Keeps the orchestrator from editing files or running shell commands.
- Adds a sidebar section with collapsible PRIMARY, WORKERS, and REVIEWERS groups, each agent's model right-aligned, plus running child sessions.
- Groups subagents by ID: `reviewer-*` agents go to REVIEWERS, the rest to WORKERS. PRIMARY and WORKERS start open, REVIEWERS starts collapsed; click a header to toggle it.
- Injects delegation guidance into the orchestrator's system context.

The installer places the agent definitions in the global `~/.config/opencode/agents/` directory or a project's `.opencode/agents/` directory. The plugin cannot create agents at runtime.

## Delegation

The orchestrator uses OpenCode's built-in `subagent` tool. Independent work is launched with `background: true`. The tool creates a child session, returns its session ID immediately, and notifies the parent when the child finishes. The orchestrator does not create sessions itself.

Foreground `subagent` calls are reserved for work that must finish before the next step. Passing a returned `sessionID` back to `subagent` continues the same child conversation.

`maxParallel` controls only the prompt instruction. It does not enforce a hard limit in the runtime.

## Models

Assign models in `opencode.jsonc` under the native `agents` key:

```jsonc
{
  "agents": {
    "orchestrator": { "model": "opencode-go/deepseek-v4.1-flash" },
    "reviewer-general": { "model": "opencode-go/muse-spark-1.3-contributor" }
  }
}
```

Use `provider/model`, optionally followed by `#variant`. Agents without an explicit model inherit the parent session model. The sidebar shows the configured model or `inherit`.

The plugin does not map models itself. OpenCode's agent transform only sees built-in agents during plugin setup, so a plugin-side model map cannot reliably apply to Markdown agents.

## Configuration

```jsonc
{
  "plugins": [
    {
      "package": "openchoreographer",
      "options": {
        "agent": "orchestrator",
        "maxParallel": 4
      }
    }
  ]
}
```

- `agent`: ID of the primary orchestrator agent.
- `maxParallel`: Number of background subagents the orchestrator is told to run at once. Clamped to 1-8.

## Usage

Run the orchestrator directly:

```text
opencode run --agent orchestrator --auto "Add a retry with backoff to the upload client and run the relevant tests."
```

If `default_agent` is set to `"orchestrator"` in `opencode.jsonc`, new sessions use the orchestrator by default. Use `/orchestrate` to switch an existing session. Use `/review-panel` for a strict review of the current changes.

The orchestrator reads and searches, then delegates edits and commands to workers. Reviewers are read-only.
