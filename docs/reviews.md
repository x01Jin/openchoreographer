# Reviews

Run it on changes that arrived from elsewhere: a pull, a teammate's branch, or manual edits. The orchestrator already runs reviewers before delegation and after its workers edit, so an orchestration run needs no separate panel; `/review-panel` gives that same panel without starting a run.

`/review-panel` builds a brief and hands it to the orchestrator. The brief always runs `reviewer` once with the `correctness` lens, then at most `maxReviewers - 1` further lens calls, each as its own `reviewer` call with `lens: <id>`. `reviewer-security` is an additional call outside that cap, added only when its triggers fire.

The lens table lives in `src/shared/review.ts` and is injected into the brief as one `id — label: hint` line per lens. The eleven lenses are correctness, oop, functional, procedural, concurrency, distributed, data, api, frontend, performance, and testing.

`reviewer-security` runs when the change touches auth, input handling, secrets, deserialization, SSRF, paths, HTML output, or SQL/shell construction. `reviewer` findings are one line each (`file:line — defect — fix`), at most 6 (at most 4 for security), ending with a `VERDICT` line. Findings dedupe on identical file:line:issue, keeping the more specific lens' finding. Claims that cannot be verified go under `Unverified:`, never as findings. A reviewer that returns no `VERDICT` line counts as failed and is rerun once with a narrower file list.

Plan-stage reviews use three separate agents before the first delegation. `reviewer-scope` runs only when the value of the work is genuinely unclear (a rewrite, a new subsystem, work that may already exist); it is advisory and ends with `BUILD`, `DEFER`, or `REJECT`. `reviewer-plan` runs on the written plan for Tier 2 and Tier 3 work and returns numbered findings with severity, quoted plan text, and a concrete fix; blocker findings are fixed before delegating. `reviewer-execution` runs on the revised plan when `reviewer-plan` found blockers, or when the plan cites files or symbols the orchestrator has not verified; it returns `VERDICT: PASS` or `VERDICT: BLOCK` followed by blockers only. Tier 1 work skips plan review.

All reviewers are read-only. The review context hook removes `edit`, `write`, `patch`, `shell`, and `subagent` from every reviewer, and `question` from every reviewer except `reviewer-plan`, so reviewers cannot edit, run commands, or delegate; `reviewer-plan` is the exception and may ask a clarifying question with the `question` tool, while the other reviewers cannot.
