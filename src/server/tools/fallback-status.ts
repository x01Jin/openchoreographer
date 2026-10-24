import type { Plugin } from "@opencode/plugin"
import { AGENT_IDS, ORCHESTRATOR_ID } from "../../shared/agents"
import { type Breaker } from "../../shared/fallback"
import type { ModelSettings } from "../../shared/settings"
import { resolveFallbacks, resolvePrimary } from "../models"

export function fallbackStatusTool(ctx: Plugin.Context, breaker: Breaker, getModels: () => ModelSettings) {
  return ctx.tool.transform((editor) => {
    editor.add({
      name: "fallback_status",
      description: "Report each managed agent's primary model, fallbacks configured in the settings dialog, and any active rate-limit backoff.",
      input: { type: "object", properties: {}, additionalProperties: false },
      options: { permission: "read" },
      execute: async () => {
        try {
          const managed: readonly string[] = AGENT_IDS.filter((id) => id !== ORCHESTRATOR_ID)
          const overrides = getModels()
          const agents = await Promise.all(
            managed.map(async (agent) => {
              const primary = await resolvePrimary(ctx, agent, overrides)
              const fallbacks = resolveFallbacks(agent, overrides)
              const models = primary === undefined ? [...fallbacks] : [primary, ...fallbacks]
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
