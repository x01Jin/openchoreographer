# Development

The repo layout is `index.ts` (server composition root), `tui.tsx` (thin TUI re-export), `src/tui/tui.tsx` (TUI implementation), `src/tui/tui.js` (compiled TUI entry), `src/shared` (pure helpers), `src/server` (tools, hooks, commands, agent registration), `src/tui` (Solid components), `agents` (the fourteen agent definitions), `scripts/build-tui.ts`, and `tests`.

## Build

The TUI must be plain JavaScript. OpenCode's Bun loader transforms `.tsx` with React's JSX runtime, which the terminal host does not ship, so a raw `tui.tsx` entry fails with `Cannot find package 'react'`. `scripts/build-tui.ts` compiles the four `src/tui/*.tsx` inputs with Babel's Solid preset and rewrites their relative imports to `.js`.

```sh
npm run build:tui
npm run check:tui
```

The generated `src/tui/tui.js`, `src/tui/sidebar.js`, `src/tui/settings-panel.js`, and `src/tui/flowing-label.js` are committed. `npm run prepack` rebuilds them before publishing. Edit the `.tsx` sources, not the generated files.

## Checks

```sh
npm run typecheck
npm test
```

`tsc --noEmit` covers `*.ts`, `*.tsx`, `src/**`, `tests/*.ts`, and `scripts/*.ts`. `npm test` runs the six suites listed in `package.json`; a new test file must be added to that list.

## Agent registration

`src/server/agent-source.ts` parses `agents/*.md` at setup, converts the native `permissions` list, and registers every definition through `ctx.agent.transform`. Disabling a subagent removes it from the editor and calls `ctx.agent.reload()`; no file moves, no `.disabled` copies, no orchestrator sidecars.

Agent ids and definitions are duplicated in `src/shared/agents.ts`, `agents/*.md`, the [roster table](roster.md), and `tests/agents.test.ts` (exactly 14 `.md` files). Update all of them together.

## Style

No semicolons in `index.ts`, `tui.tsx`, and `src/**/*.ts` / `src/**/*.tsx`; semicolons in `tests/*.ts` and `scripts/*.ts`.
