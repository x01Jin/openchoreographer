import type { Plugin } from "@opencode/plugin"
import { EXPLORE_ID, REVIEWER_IDS, WORKER_IDS } from "../../shared/agents"
import { type Breaker } from "../../shared/fallback"
import type { Options } from "../../shared/options"
import { resolvePrimary } from "../models"

export function fallbackStatusTool(ctx: Plugin.Context, options: Options, breaker: Breaker) {
  return ctx.tool.transform((editor) => {
    editor.add({
      name: "fallback_status",
      description: "Report each managed agent's primary model, configured fallbacks, and any active rate-limit backoff.",
      input: { type: "object", properties: {}, additionalProperties: false },
      options: { permission: "read" },
      execute: async () => {
        try {
          const managed: readonly string[] = [EXPLORE_ID, ...WORKER_IDS, ...REVIEWER_IDS]
          const agents = await Promise.all(
            managed.map(async (agent) => {
              const primary = await resolvePrimary(ctx, agent)
              const fallbacks = options.fallback[agent] ?? []
              const models = primary === undefined ? fallbacks : [primary, ...fallbacks]
              return {
                agent,
                primary: primary === undefined ? null : primary.key,
                fallbacks: fallbacks.map((model) => model.key),
                backoffMs: models
                  .map((model) => ({ model: model.key, waitMs: breaker.waitMs(model) }))
                  .filter((entry) => entry.waitMs > 0),
              }
            }),
          )
          return { content: JSON.stringify({ agents }, null, 2) }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { content: "fallback status unavailable: " + message }
        }
      },
    })
  })
}
