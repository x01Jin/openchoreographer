# Reviews

Run it on changes that arrived from elsewhere: a pull, a teammate's branch, or manual edits. The orchestrator already runs reviewers before delegation and after workers edit, so an orchestration run needs no separate panel. `/review-panel` gives that same panel without starting a run.

`/review-panel` builds a brief and hands it to the orchestrator. The brief always runs `reviewer` once with the `correctness` lens. At most `maxReviewers - 1` further lens calls are allowed, and only when the diff directly touches that lens's domain. The cap is a ceiling, not a target.

The lens table lives in `src/shared/review.ts` and is injected as one `id: label` line per lens. The eleven lenses are correctness, oop, functional, procedural, concurrency, distributed, data, api, frontend, performance, and testing.

`reviewer-security` runs when the change touches auth, input handling, secrets, deserialization, SSRF, paths, HTML output, or SQL/shell construction. This call does not count toward the lens cap. `reviewer` findings are one line each (`file:line` defect and fix), at most 6, at most 4 for security, ending with a `VERDICT:` line. A reviewer that returns no `VERDICT` line is rerun once with a narrower file list.

When findings exist, one `reviewer` call with the task prefixed `reflect` and `lens: correctness` runs on the same findings and diff. It may drop findings the diff disproves, move undecidable ones to `Unverified:`, and never add findings. It does not count toward the lens cap.

Plan-stage reviews use three agents before the first delegation. `reviewer-plan` runs on the written plan for Tier 3 work. `reviewer-execution` runs when the plan changed after blocker findings or cites unverified symbols. `reviewer-scope` runs only when the value of the work is genuinely unclear and is advisory. Tier 1 and Tier 2 work skip plan review.

All reviewers are read-only. The review context hook removes `edit`, `write`, `patch`, `shell`, and `subagent` from every reviewer, and `question` from every reviewer except `reviewer-plan`.
