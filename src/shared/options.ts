import { parseModel, type ParsedModel } from "./fallback"
import { EXPLORE_ID, REVIEWER_IDS, SPECIALIST_IDS, WORKER_IDS } from "./agents"

export type Options = {
  readonly agent: string
  readonly maxParallel: number
  readonly maxReviewers: number
  readonly fallback: Readonly<Record<string, readonly ParsedModel[]>>
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function normalizeOptions(raw: Record<string, unknown> | undefined): Options {
  if (!raw || typeof raw !== "object") return { agent: "orchestrator", maxParallel: 4, maxReviewers: 2, fallback: {} }
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
  return { agent, maxParallel, maxReviewers, fallback: normalizeFallback(raw.fallback) }
}

function describeRejected(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value)
  if (value === null) return "null"
  if (typeof value !== "object") return typeof value
  // JSON.stringify throws on cycles and bigint, so object payloads are not printed.
  return Array.isArray(value) ? "array" : "object"
}

function normalizeFallback(raw: unknown): Readonly<Record<string, readonly ParsedModel[]>> {
  if (raw === undefined) return {}
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    const received = raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw
    console.warn(`orchestrator options: expected object for "fallback", received ${received}`)
    return {}
  }
  const valid = [...WORKER_IDS, EXPLORE_ID, ...SPECIALIST_IDS, ...REVIEWER_IDS]
  const result: Record<string, ParsedModel[]> = {}
  for (const [id, value] of Object.entries(raw)) {
    if (!WORKER_IDS.includes(id) && id !== EXPLORE_ID && !SPECIALIST_IDS.includes(id) && !REVIEWER_IDS.includes(id)) {
      console.warn(`orchestrator options: ignoring "fallback" entry for unknown agent "${id}"; valid ids: ${valid.join(", ")}`)
      continue
    }
    const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : undefined
    if (values === undefined) {
      console.warn(`orchestrator options: expected string or array for "fallback.${id}", received ${value === null ? "null" : typeof value}`)
      continue
    }
    const parsed: ParsedModel[] = []
    for (const entry of values) {
      const model = parseModel(entry)
      if (model === undefined) {
        console.warn(`orchestrator options: ignoring invalid fallback model ${describeRejected(entry)} for agent "${id}"`)
        continue
      }
      parsed.push(model)
    }
    if (parsed.length > 0) result[id] = parsed
  }
  return result
}
