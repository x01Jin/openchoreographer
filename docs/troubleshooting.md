# Troubleshooting

- Missing agent definitions: the plugin logs a warning naming the unregistered agents and still loads. Re-run `node bin/install.mjs --force`, then restart OpenCode.
- Sidebar empty: the TUI half failed to resolve `solid-js`. Re-run the installer without `--no-deps`.
- Commands registered twice: two copies of the plugin are loaded. Remove one; see [install](install.md) for why a local copy and the npm or GitHub package must not load together.
- Diff counts that look like whole files: the VCS provider is comparing a CRLF working tree against LF blobs. The [diff](diff.md) tool collapses that churn; if the counts still look wrong, check `git ls-files --eol` and the repository's line-ending configuration.
- Quota failures on every spawn with no fallback switch: the agent inherits a free-tier parent model and has no fallback override. Set a primary and a fallback in the dialog; see [models](models.md). A background child that hits quota fails inside its own session after the parent already received its sessionID, so there is no spawn-time retry for it.
- Settings changes that do not stick: the server half is not running, so the dialog applies animation and interface toggles from the TUI's own storage and leaves the agent rows unavailable. Restart OpenCode and try again.
- Stale installed agents after a pull: the bundle moved but the installed copies in `~/.config/opencode/agents/` (or `.opencode/agents`) still hold the old bodies. Re-run with `--force`, and add `--prune` if retired reviewer files remain; see [install](install.md).
