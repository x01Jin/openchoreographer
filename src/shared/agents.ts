export const ORCHESTRATOR_ID = "orchestrator"
export const EXPLORE_ID = "explore"
export const WORKER_IDS: readonly string[] = ["backend", "frontend", "database", "devops", "tester"]
export const SPECIALIST_IDS: readonly string[] = ["designer", "writer"]
export const REVIEWER_PLAN_ID = "reviewer-plan"
export const REVIEWER_IDS: readonly string[] = ["reviewer", "reviewer-security", REVIEWER_PLAN_ID, "reviewer-execution", "reviewer-scope"]
export const TEAM_IDS: readonly string[] = ["backend", "frontend", "database", "devops", "tester", "designer", "writer", EXPLORE_ID]
export const AGENT_IDS: readonly string[] = [ORCHESTRATOR_ID, EXPLORE_ID, ...WORKER_IDS, ...SPECIALIST_IDS, ...REVIEWER_IDS]
export const SUBAGENT_IDS: readonly string[] = AGENT_IDS.filter((id) => id !== ORCHESTRATOR_ID)

export type ModelGroup = { readonly id: "workers" | "reviewers"; readonly label: string; readonly ids: readonly string[] }

export const MODEL_GROUPS: readonly ModelGroup[] = [
  { id: "workers", label: "WORKERS", ids: [EXPLORE_ID, ...WORKER_IDS, ...SPECIALIST_IDS] },
  { id: "reviewers", label: "REVIEWERS", ids: [...REVIEWER_IDS] },
]

// The bundle defines no step budgets: agents are uncapped unless their file
// carries a `steps:` key. An empty record keeps existing imports compiling;
// nothing here may supply a per-agent budget.
export const STEP_DEFAULTS: Readonly<Record<string, number>> = {}

export function isReviewer(id: string): boolean {
  return REVIEWER_IDS.includes(id)
}

export function isWorker(id: string): boolean {
  return WORKER_IDS.includes(id)
}
