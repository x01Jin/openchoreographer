import type { Options } from "./options"
import { PARALLEL_DEFAULT } from "./settings"

type Lens = {
  readonly id: string
  readonly label: string
  readonly focus: readonly string[]
}

export const LENSES: readonly Lens[] = [
  {
    id: "correctness",
    label: "Correctness",
    focus: [
      "Correctness against stated intent",
      "Boundaries: empty, null, zero, negative, max, off-by-one",
      "Error paths, partial failure, and cleanup",
      "Regressions in callers and existing behavior",
      "Missing tests for changed behavior",
      "Style only where it hides a defect"
    ]
  },
  {
    id: "oop",
    label: "Object-oriented",
    focus: [
      "Single responsibility and cohesion",
      "Encapsulation and invariant protection",
      "Composition over inheritance",
      "Dependency direction and inversion",
      "Interface width and leaky abstractions",
      "Lifecycle: initialization and disposal",
      "Shared mutable state and aliasing",
      "Substitutability and contract violations"
    ]
  },
  {
    id: "functional",
    label: "Functional",
    focus: [
      "Purity and hidden side effects",
      "Immutability and shared mutable references",
      "Totality: exhaustive matching, no partial functions",
      "Errors as values versus thrown exceptions",
      "Effect boundaries and where I/O is allowed",
      "Referential transparency and evaluation order",
      "Composition, laziness, and transformation pipelines",
      "Illegal states the types still allow"
    ]
  },
  {
    id: "procedural",
    label: "Procedural",
    focus: [
      "Control flow and early exits",
      "State machines and reachable states",
      "Invariants at function boundaries",
      "Loop bounds, recursion depth, and termination",
      "Resource acquisition and cleanup on every path",
      "Error propagation and cleanup during failure",
      "Global state, init order, and reentrancy"
    ]
  },
  {
    id: "concurrency",
    label: "Concurrency",
    focus: [
      "Data races, atomicity, and visibility",
      "Deadlocks and lock ordering",
      "Locks held across await, I/O, or callbacks",
      "Cancellation and timeout propagation",
      "Backpressure, unbounded queues, and pool limits",
      "Ordering and happens-before guarantees",
      "Unhandled rejections and async error paths",
      "Reentrancy and shared mutable state"
    ]
  },
  {
    id: "distributed",
    label: "Distributed",
    focus: [
      "Idempotency and duplicate delivery",
      "Retries, backoff, jitter, and retry storms",
      "Timeouts and deadline propagation",
      "Partial failure and compensation",
      "Consistency, ordering, and exactly-once claims",
      "Observability: correlation IDs, logs, metrics, traces",
      "Schema evolution and backward compatibility",
      "Clock skew and network partitions"
    ]
  },
  {
    id: "data",
    label: "Data",
    focus: [
      "Schema design, normalization, and nullability",
      "Migrations: forward path, rollback, locking, backfill",
      "Constraints and referential integrity",
      "Transactions, isolation, and concurrent writes",
      "Indexes and query plans",
      "Cascades and deletion behavior",
      "Retention, privacy, and irreversible changes",
      "Idempotent migrations and seed data"
    ]
  },
  {
    id: "api",
    label: "API",
    focus: [
      "Contract shape, naming, and consistency",
      "Versioning and backward compatibility",
      "Request and response validation",
      "Error semantics and status codes",
      "Pagination, filtering, and sorting",
      "Idempotency and retry behavior",
      "Auth, authorization, and rate limits",
      "Docs and examples matching the code"
    ]
  },
  {
    id: "frontend",
    label: "Frontend",
    focus: [
      "Rendering correctness and stable identity",
      "State ownership and derived state",
      "Effects, cleanup, and dependency correctness",
      "Accessibility: semantics, labels, focus, keyboard, announcements",
      "Loading, empty, error, and disabled states",
      "Responsive layout, overflow, and long content",
      "Hydration and server/client mismatch",
      "Bundle size, client performance, and unsafe HTML"
    ]
  },
  {
    id: "performance",
    label: "Performance",
    focus: [
      "Time and space complexity",
      "Allocations and copies in hot paths",
      "I/O count, N+1 queries, and chatty calls",
      "Caching correctness and invalidation",
      "Batching, streaming, and backpressure",
      "Memory growth, leaks, and unbounded collections",
      "Unmeasured claims need a benchmark or profile",
      "Speed trade-offs that risk correctness"
    ]
  },
  {
    id: "testing",
    label: "Testing",
    focus: [
      "Behavior coverage, not line coverage",
      "Assertions that can actually fail",
      "Isolation and determinism",
      "Flakiness from time, randomness, network, order",
      "Fixtures, factories, and shared state",
      "Mock fidelity and over-mocking",
      "Failure cases, boundaries, and error messages",
      "Tests that pass for the wrong reason"
    ]
  }
]

export function buildDelegationText(options: Options, disabled: readonly string[] = [], maxParallel: number = PARALLEL_DEFAULT): string {
  const base = `Delegate independent work with the built-in subagent tool using background: true, keeping at most ${maxParallel} background subagents at once. The tool creates the child session and returns its sessionID, so never create or switch top-level sessions yourself. Issue several subagent calls in one step when the tasks run in parallel, and do not start a second writer on files another worker owns.`
  if (disabled.length === 0) return base
  return `${base}\nDisabled subagents (do not delegate; ignore their instructions): ${disabled.join(", ")}.`
}

export function buildReviewBrief(options: Options, disabled: readonly string[] = []): string {
  if (disabled.includes("reviewer")) {
    return `The review panel is unavailable because the "reviewer" subagent is disabled in /choreographer. Enable it to run /review-panel.`
  }
  const table = LENSES.map((lens) => `${lens.id} — ${lens.label}: ${lens.focus[0]}`).join("\n")
  const further = Math.max(0, options.maxReviewers - 1)
  const step2 =
    further === 0
      ? "2. Always run `reviewer` once with the `correctness` lens only. No further lens calls are allowed."
      : `2. Always run \`reviewer\` with the \`correctness\` lens. Then pick at most ${further} further lens calls from the table below that match the change, and run each as its own \`reviewer\` call with \`lens: <id>\`.`
  const lines = [
    "Run a strict review panel on the current changes.",
    "",
    `1. Inspect the working tree with the \`diff\` tool. Identify changed files, languages, and the blast radius.`,
    step2,
    "3. Route with this table:",
    table,
  ]
  if (!disabled.includes("reviewer-security")) {
    lines.push("4. Route `reviewer-security` as well when the change touches auth, input handling, secrets, deserialization, SSRF, paths, HTML output, or SQL/shell construction. This is an additional call that does not count toward the lens-call cap; skip it when the triggers do not match.")
  }
  lines.push(
    "5. Launch with `background: true`, keep the sessionIDs, collect results, dedupe on identical file:line:issue keeping the more specific lens' finding, and list anything unverified separately.",
    "6. If a reviewer returns no VERDICT line, treat its review as failed and rerun it once with a narrower file list."
  )
  return lines.join("\n")
}
