# Diff tool

`diff` is the read-only way the orchestrator and reviewers see what changed. Neither has shell access, so this tool is how they verify workers.

It takes five parameters. `mode` is `working` (uncommitted, the default), `branch` (against the merge base), or `committed` (the last commit). `base` compares against another ref instead of the default. `context` sets 0-10 lines around each hunk (default 3). `path` narrows the output to files whose path includes the string. `stat` returns a counts-only listing with no patches.

Output is one block per file with its status and addition/deletion counts, capped at 60000 characters. Past the cap the text is cut with a marker telling you to pass `path` to narrow or `base` to compare against another ref. The `stat` form keeps the same `Risk:` header followed by one `<status> <file> +<additions> -<deletions>` line per file, and the cap still applies.

The first line is a routing line: `Risk: <n> files, +<additions> -<deletions>. Signals: <category> (<file>) ... Lenses: <ids>.` Signals cover auth, secrets, sql, shell, and html, at most three, sanitized onto one line. The suggested lenses are always correctness, plus security when any signal fires and data when sql fires. That is a floor: path traversal, SSRF, and deserialization stay judgment calls for the reviewers.

A `path` that matches nothing returns `No files match path "<needle>". <n> files changed in mode <mode>.` An empty result returns `No changes in mode <mode>.` (or `No changes in mode <mode> against <base>.` when `base` is set). A VCS failure returns `diff unavailable: <message>` as content rather than an error.

When the working tree is CRLF and the repository blobs are LF, the provider reports every modified file as a full rewrite. The tool collapses `-`/`+` pairs that differ only by a trailing carriage return, recomputes each file's addition and deletion counts, and drops files that differ only in line endings. A reordered block is not collapsed. The output is for reading, not a patch you can apply.
