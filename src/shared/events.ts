// Streaming events are excluded on purpose because the sidebar shows session structure, status, and todos, not message text.
export const SIDEBAR_REFRESH_EVENTS: ReadonlySet<string> = new Set([
  "session.created",
  "session.deleted",
  "session.forked",
  "session.moved",
  "session.renamed",
  "session.archived",
  "session.unarchived",
  "session.metadata.updated",
  "session.agent.selected",
  "session.model.selected",
  "agent.updated",
  "model.updated",
])

export function shouldRefreshSidebar(type: string): boolean {
  return SIDEBAR_REFRESH_EVENTS.has(type)
}

const SIDEBAR_STATUS_EVENTS: ReadonlySet<string> = new Set([
  "session.status",
  "session.idle",
  "session.step.ended",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.compaction.started",
  "session.compaction.ended",
  "session.compaction.failed",
])

export function isSidebarStatusEvent(type: string): boolean {
  return SIDEBAR_STATUS_EVENTS.has(type)
}
