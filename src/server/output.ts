import type { Plugin } from "@opencode/plugin"
import { clipShellOutput, clipShellParts } from "../shared/results"

export function outputClipHook(ctx: Plugin.Context) {
  return ctx.tool.hook("execute.after", (event) => {
    if (event.tool !== "shell" && event.tool !== "bash") return
    // The error branch carries no result, so only a finished call has text to budget.
    if (event.status !== "completed") return
    // Clipping is best-effort: a mutation failure must never turn a finished call into an error.
    try {
      const result = event.result
      if (typeof result.content === "string") {
        const text = result.content
        const clipped = clipShellOutput(text)
        if (clipped.text === text) return
        event.result = {
          ...result,
          content: clipped.text,
          metadata: { ...result.metadata, outputBudget: { dropped: clipped.dropped } },
        }
        return
      }
      if (!Array.isArray(result.content)) return
      // One budget for the whole call: per-part limits would let five long parts through untouched.
      const clipped = clipShellParts(result.content)
      if (clipped.dropped === 0) return
      event.result = {
        ...result,
        content: clipped.parts,
        metadata: { ...result.metadata, outputBudget: { dropped: clipped.dropped } },
      }
    } catch (error) {
      console.warn(`openchoreographer: output budget skipped for a ${event.tool} result: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}
