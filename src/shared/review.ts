import type { Options } from "./options"
import { PARALLEL_DEFAULT } from "./settings"

type Lens = { readonly id: string; readonly label: string }

export const LENSES: readonly Lens[] = [
  { id: "correctness", label: "Correctness" },
  { id: "oop", label: "Object-oriented" },
  { id: "functional", label: "Functional" },
  { id: "procedural", label: "Procedural" },
  { id: "concurrency", label: "Concurrency" },
  { id: "distributed", label: "Distributed" },
  { id: "data", label: "Data" },
  { id: "api", label: "API" },
  { id: "frontend", label: "Frontend" },
  { id: "performance", label: "Performance" },
  { id: "testing", label: "Testing" },
]

export function buildDelegationText(options: Options, maxParallel: number = PARALLEL_DEFAULT): string {
  return `Delegate with the built-in subagent tool and background: true, at most ${maxParallel} children at once. The tool creates the child session and returns its sessionID; never create top-level sessions. Batch independent tasks into one step, and never start a second writer on files another worker owns.`
}

export function buildReviewBrief(options: Options): string {
  const table = LENSES.map((lens) => `${lens.id}: ${lens.label}`).join("\n")
  const further = Math.max(0, options.maxReviewers - 1)
  const lensCalls = further === 1 ? "call" : "calls"
  const step2 =
    further === 0
      ? "2. Always run `reviewer` once with the `correctness` lens only. No further lens calls are allowed."
      : `2. Always run \`reviewer\` with the \`correctness\` lens. Then pick at most ${further} further lens ${lensCalls} from the table below, and only when the diff directly touches that lens's domain. If none match, stop after correctness: the cap is a ceiling, not a target. Run each as its own \`reviewer\` call with \`lens: <id>\`.`
  const lines = [
    "Run a strict review panel on the current changes.",
    "",
    `1. Inspect the working tree with the \`diff\` tool. Identify changed files, languages, and the blast radius.`,
    step2,
    "3. Route with this table:",
    table,
  ]
  lines.push("4. Route `reviewer-security` as well when the change touches auth, input handling, secrets, deserialization, SSRF, paths, HTML output, or SQL/shell construction. This is an additional call that does not count toward the lens-call cap; skip it when the triggers do not match.")
  lines.push(
    "5. Launch with `background: true`, keep the sessionIDs, collect results, dedupe on identical file:line:issue keeping the more specific lens' finding, and list anything unverified separately.",
    "6. When a reviewer returns findings, run one `reviewer` call with the task prefixed `reflect` and `lens: correctness`, on the same findings and diff. It sees only the diff, drops findings the diff disproves, moves findings the diff cannot decide to `Unverified:`, adds none, and does not count toward the lens cap. Skip it when the verdict is clean.",
    "7. If a reviewer returns no VERDICT line, treat its review as failed and rerun it once with a narrower file list."
  )
  return lines.join("\n")
}
