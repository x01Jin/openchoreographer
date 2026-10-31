# Troubleshooting

- Missing agent definitions: the plugin logs `agent registration failed` with the parser error and still loads. Check `agents/*.md` frontmatter. Run `/reload` after fixing it.
- TUI plugin failed with `Cannot find package 'react'`: an old package shipped `tui.tsx` as the `./tui` entry. Version 1.4.1 exports `src/tui/tui.js`. Run `opencode plugin update openchoreographer`.
- Sidebar empty: the TUI half failed to resolve `solid-js` or `@opentui/*`. Reinstall with `opencode plugin remove openchoreographer` and then `opencode plugin add openchoreographer@latest`.
- Commands registered twice: the checkout and the npm package are both loaded. Remove one entry from `plugins`.
- Diff counts that look like whole files: the VCS provider is comparing a CRLF working tree against LF blobs. The [diff](diff.md) tool collapses that churn; if the counts still look wrong, check `git ls-files --eol`.
- Quota failures on every spawn with no fallback switch: the agent inherits a free-tier parent model and has no fallback override. Set a primary and a fallback in the dialog; see [models](models.md).
- Settings changes that do not stick: the server half is not running. Restart OpenCode and try again.
- Disabled subagent still appears: the transform has not reloaded. Run `/reload`; if it persists, another plugin or an old `~/.config/opencode/agents/<id>.md` is registering it. Delete that stale file.
