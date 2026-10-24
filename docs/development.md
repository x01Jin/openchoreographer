# Development

The repo layout is `index.ts` (server composition root), `tui.tsx` (TUI composition root), `src/shared` (pure helpers), `src/server` (tools, hooks, commands), `src/tui` (Solid components), `agents` (the fourteen agent definitions), `bin` (the installer), and `tests`.

There is no build or emit step. The host loads `index.ts` and `tui.tsx` (TypeScript source) directly through the `exports` map, so do not add a bundler, emit step, or `build` script. New source files need no installer list entry: `package.json` `files` includes `src`, and the installer walks `src/` recursively. Everything a runtime module imports must be inside `src/` or shipped with the plugin.

Typecheck with `npm run typecheck` (`tsc --noEmit` over `*.ts`, `*.tsx`, `tests/*.ts`, and `bin/install.mjs` through allowJs/checkJs, so JSDoc in the installer is checked). Run tests with `npm test`, which runs the six suites listed explicitly in `package.json`; a new test file must be added to that list or it never runs. `node bin/install.mjs --dry-run` prints planned actions and writes nothing; `npm run smoke:install` is a project-mode dry run. `tsx` is a dev-only dependency and is not shipped. `@opentui/core` wants Node >= 26.4, so `EBADENGINE` on install is harmless here; the installer itself needs Node >= 22.6.

Style: no semicolons in `index.ts`, `tui.tsx`, and `src/**/*.ts` / `src/**/*.tsx`; semicolons in `tests/*.ts` and `bin/install.mjs`. Match the file you touch.

Agent ids and step defaults are duplicated in `src/shared/agents.ts` (`AGENT_IDS`, `WORKER_IDS`, `SPECIALIST_IDS`, `REVIEWER_IDS`, `STEP_DEFAULTS`), `agents/*.md`, the [roster table](roster.md), and `tests/agents.test.ts` (exactly 14 `.md` files). Update all of them together.
