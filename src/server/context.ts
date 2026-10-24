import type { Plugin } from "@opencode/plugin"
import { isReviewer, isWorker, REVIEWER_PLAN_ID } from "../shared/agents"
import type { Options } from "../shared/options"
import { buildDelegationText } from "../shared/review"

export function contextHook(ctx: Plugin.Context, options: Options) {
  return ctx.session.hook("context", (event) => {
    if (event.agent === options.agent) {
      event.system.push({
        type: "text",
        text: `TODO discipline:
- Write the list before the first tool call; each item is one verifiable action phrased as the action.
- At each step transition, in one write mark the finished item completed and the next in_progress, adding a mid-task step there too; never batch completions to the end.
- Never end a turn with an item pending or in_progress unless blocked, and say what blocks it.`,
      })
      delete event.tools.edit
      delete event.tools.write
      delete event.tools.patch
      delete event.tools.shell
      event.system.push({ type: "text", text: buildDelegationText(options) })
      return
    }
    if (isReviewer(event.agent)) {
      delete event.tools.edit
      delete event.tools.write
      delete event.tools.patch
      delete event.tools.shell
      delete event.tools.subagent
      if (event.agent !== REVIEWER_PLAN_ID) {
        delete event.tools.question
      }
      return
    }
    if (isWorker(event.agent)) {
      delete event.tools.subagent
      delete event.tools.question
      delete event.tools.diff
    } else {
      delete event.tools.diff
    }
  })
}
