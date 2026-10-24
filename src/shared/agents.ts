export const ORCHESTRATOR_ID = "orchestrator"
export const EXPLORE_ID = "explore"
export const WORKER_IDS: readonly string[] = ["backend", "frontend", "database", "devops", "tester"]
export const SPECIALIST_IDS: readonly string[] = ["designer", "writer"]
export const REVIEWER_IDS: readonly string[] = ["reviewer", "reviewer-security"]
export const AGENT_IDS: readonly string[] = [ORCHESTRATOR_ID, EXPLORE_ID, ...WORKER_IDS, ...SPECIALIST_IDS, ...REVIEWER_IDS]
export const SUBAGENT_IDS: readonly string[] = AGENT_IDS.filter((id) => id !== ORCHESTRATOR_ID)

export type ModelGroup = { readonly id: "workers" | "reviewers"; readonly label: string; readonly ids: readonly string[] }

export const MODEL_GROUPS: readonly ModelGroup[] = [
  { id: "workers", label: "WORKERS", ids: [EXPLORE_ID, ...WORKER_IDS, ...SPECIALIST_IDS] },
  { id: "reviewers", label: "REVIEWERS", ids: [...REVIEWER_IDS] },
]

// Step budgets the settings dialog resets an agent to when its override is cleared.
export const STEP_DEFAULTS: Readonly<Record<string, number>> = {
  orchestrator: 90,
  explore: 50,
  backend: 80,
  frontend: 80,
  database: 60,
  devops: 60,
  tester: 70,
  designer: 40,
  writer: 50,
  reviewer: 40,
  "reviewer-security": 35,
}

export function isReviewer(id: string): boolean {
  return REVIEWER_IDS.includes(id)
}

export function isWorker(id: string): boolean {
  return WORKER_IDS.includes(id)
}
