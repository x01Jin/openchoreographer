import type { Plugin } from "@opencode/plugin"
import { isReviewer, isWorker, REVIEWER_PLAN_ID } from "../shared/agents"
import type { Options } from "../shared/options"
import { clipSubagentReports } from "../shared/results"
import { PARALLEL_DEFAULT } from "../shared/settings"
import { buildDelegationText } from "../shared/review"

export function contextHook(ctx: Plugin.Context, options: Options, getMaxParallel: () => number = () => PARALLEL_DEFAULT) {
  return ctx.session.hook("context", (event) => {
    if (event.agent === options.agent) {
      event.system.push({
        type: "text",
        text: `TODO discipline: write the list before the first tool call, update it at each step transition, and never end a turn with pending work unless blocked.`,
      })
      delete event.tools.edit
      delete event.tools.write
      delete event.tools.patch
      delete event.tools.shell
      event.system.push({ type: "text", text: buildDelegationText(options, getMaxParallel()) })

      try {
        const clipped = clipSubagentReports(event.messages)

        if (clipped.clipped > 0) event.messages = clipped.messages
      } catch (error) {
        console.warn(`openchoreographer: subagent report budget skipped: ${error instanceof Error ? error.message : String(error)}`)
      }
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
