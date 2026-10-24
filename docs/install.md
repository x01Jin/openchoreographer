# Install

Requires OpenCode V2 (plugin API 2.1.x) and Node 22.6+ for the installer. Full flag details are below; the short version is in the [landing page](../README.md).

```sh
opencode plugin add openchoreographer
npx openchoreographer --no-plugin
```

The first command registers the plugin. The second writes the fourteen agent definitions into `~/.config/opencode/agents/` and `--no-plugin` stops the installer from copying a second copy of the plugin into `~/.config/opencode/plugins/`. Restart OpenCode afterwards.

From a clone, or to pin a commit:

```sh
gh repo clone x01Jin/openchoreographer
cd openchoreographer
node bin/install.mjs --no-plugin
opencode plugin add github:x01Jin/openchoreographer
```

## Flags

Every flag is printed by `node bin/install.mjs --help`:

- `--local`: copy the plugin plus agents into the global config dir.
- `--project`: install into `<project>/.opencode/`; implies a local plugin copy. Refuses to run from the home directory or filesystem root unless `--force` is passed.
- `--force`: overwrite files that differ.
- `--reset-steps`: restore the bundled step budgets on overwrite; requires `--force`. Without it, an existing `steps:` budget in an agent file is kept.
- `--prune`: delete retired agent files in the target directory; requires `--force`. Only the eleven retired reviewer names are ever removed.
- `--dry-run`: print planned paths and actions; write nothing.
- `--no-agents`: skip agent installation.
- `--no-deps`: skip the dependency install in the copied plugin directory.
- `--no-plugin`: install only the agent definitions; skip copying plugin files.
- `--version`: print the installer version.
- `-h`, `--help`: print usage.
- A leading `init` argument is accepted and ignored.

`--local` and `--project` are mutually exclusive. `--prune` and `--reset-steps` each require `--force`.

## Comparison and exit codes

The installer compares file content. Identical files report `same`. Files that differ without `--force` are skipped and listed as `stale`, except an agent file whose only difference is a preserved `steps:` budget, which reports `same`, is not written, and does not raise the exit code. Everything else is still written. Exit `0` means everything is installed or already current, exit `2` means at least one file differs and needs `--force`, exit `1` means an error.

## Upgrade paths

For a clone the upgrade path is `git pull && node bin/install.mjs --force`. For the npm package run `opencode plugin update`, then `npx openchoreographer --force`. `--force` keeps an existing `steps:` budget in agent files, so tuned budgets survive an upgrade; `--reset-steps` restores the bundled defaults.

Upgrading from the eighteen-agent layout copies the fourteen current files but leaves the old `reviewer-*.md` files in `~/.config/opencode/agents/` and the stale model entries in `opencode.jsonc`. `node bin/install.mjs --force --prune` removes the retired files it knows about. The `agents` entries for the eleven removed reviewer ids must be deleted from `opencode.jsonc` by hand: reviewer-general, reviewer-oop, reviewer-functional, reviewer-procedural, reviewer-concurrent, reviewer-distributed, reviewer-data, reviewer-api, reviewer-frontend, reviewer-performance, reviewer-testing.

## Dependencies

`--local` and `--project` run `npm install --omit=dev` in the copied plugin directory, because `tui.tsx` has runtime imports (`solid-js`, `@opentui/*`) that a copied directory cannot resolve on its own. `--no-deps` skips this, at the cost of the sidebar failing to load.

Do not load a local copy and the npm or GitHub package at once. Two copies register the commands and the sidebar twice.
