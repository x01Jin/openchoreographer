# Install

Requires OpenCode V2 (plugin API 2.2.x) and Node 22.6+.

```sh
opencode plugin add openchoreographer@latest
```

That is the only install step. The plugin reads its fourteen agent definitions from its own package and registers them in the server at startup. It writes no files into `~/.config/opencode/agents`, `.opencode/agents`, or `~/.config/opencode/plugins`. Restart OpenCode, or run `/reload`, after the command finishes.

OpenCode stores npm plugins under `~/.cache/opencode/npm/<package>@<spec>/<generation>/node_modules`. That cache is managed by OpenCode and is the package location the plugin loads from. It is not a second install and must not be edited.

## Upgrade

```sh
opencode plugin update openchoreographer
```

The package version is the only upgrade marker. Settings, model overrides, and the disabled-subagent list live in OpenCode's plugin storage and survive an upgrade.

## Uninstall

```sh
opencode plugin remove openchoreographer
```

## Local development

Point OpenCode at the checkout by adding the absolute directory to `plugins` in `opencode.json(c)`:

```jsonc
{
  "plugins": ["C:\\Users\\Jin\\Documents\\DEV-stuff\\projects\\openchoreographer"]
}
```

Do not load the checkout and the npm package at the same time. Both register the same commands, tools, and agents.

## Why there is no installer

The previous `npx openchoreographer` step copied agent Markdown into the config directory and could leave stale copies behind. Agent registration is in memory now, so the package and the live roster cannot drift. The only supported install path is the OpenCode command above.
