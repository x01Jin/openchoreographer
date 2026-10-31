import type { Plugin } from "@opencode/plugin"
import type { Options } from "../shared/options"
import { buildReviewBrief } from "../shared/review"

export function commands(ctx: Plugin.Context, options: Options) {
  return ctx.command.transform((editor) => {
    editor.add({
      name: "review-panel",
      description: "Run a strict review panel on the current changes",
      execute: async ({ sessionID, prompt, delivery }) => {
        await ctx.session.switchAgent({ sessionID, agent: options.agent })
        const brief = buildReviewBrief(options)
        const request = prompt.text?.trim()
        await ctx.session.prompt({
          ...prompt,
          sessionID,
          text: request ? `${brief}\n\nUser request: ${request}` : brief,
          delivery,
        })
      },
    })
  })
}
