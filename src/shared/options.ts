export type Options = {
  readonly agent: string
  readonly maxParallel: number
  readonly maxReviewers: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function normalizeOptions(raw: Record<string, unknown> | undefined): Options {
  if (!raw || typeof raw !== "object") return { agent: "orchestrator", maxParallel: 4, maxReviewers: 2 }
  const agentValue: unknown = raw.agent
  if (agentValue !== undefined && typeof agentValue !== "string") {
    console.warn(`orchestrator options: expected string for "agent", received ${typeof agentValue}`)
  }
  const agent = typeof agentValue === "string" && agentValue.trim() ? agentValue.trim() : "orchestrator"
  const parallelValue: unknown = raw.maxParallel
  if (parallelValue !== undefined && (typeof parallelValue !== "number" || !Number.isFinite(parallelValue))) {
    console.warn(`orchestrator options: expected finite number for "maxParallel", received ${typeof parallelValue}`)
  }
  const maxParallel =
    typeof parallelValue === "number" && Number.isFinite(parallelValue) ? clamp(Math.floor(parallelValue), 1, 8) : 4
  const reviewersValue: unknown = raw.maxReviewers
  if (reviewersValue !== undefined && (typeof reviewersValue !== "number" || !Number.isFinite(reviewersValue))) {
    console.warn(`orchestrator options: expected finite number for "maxReviewers", received ${typeof reviewersValue}`)
  }
  const maxReviewers =
    typeof reviewersValue === "number" && Number.isFinite(reviewersValue) ? clamp(Math.floor(reviewersValue), 1, 4) : 2
  return { agent, maxParallel, maxReviewers }
}
