import type { Plugin } from "@opencode/plugin"
import { parseModel, type ParsedModel } from "../shared/fallback"
import type { Options } from "../shared/options"

const PRIMARY_TTL_MS = 30_000
const primaryCache = new Map<string, { model: ParsedModel | undefined; at: number }>()

export async function resolvePrimary(ctx: Plugin.Context, agent: string): Promise<ParsedModel | undefined> {
  const cached = primaryCache.get(agent)
  const now = Date.now()
  if (cached !== undefined && now - cached.at < PRIMARY_TTL_MS) return cached.model
  // .then also catches a synchronous throw from the client method, which .catch on the call result would miss.
  const listed = await Promise.resolve()
    .then(() => ctx.agent.list({ location: ctx.location }))
    .catch(() => undefined)
  const found = listed?.data.find((a) => a.id === agent)
  const model =
    found?.model !== undefined
      ? parseModel(found.model.providerID + "/" + found.model.id + (found.model.variant ? "#" + found.model.variant : ""))
      : undefined
  primaryCache.set(agent, { model, at: now })
  return model
}

export async function warnNarrowFallbacks(ctx: Plugin.Context, options: Options): Promise<void> {
  try {
    const catalog = await ctx.model.list()
    const limits = new Map<string, number>()
    for (const model of catalog.data) {
      // The catalog carries the model id twice; index both so either form resolves a configured key.
      limits.set(model.providerID + "/" + model.modelID, model.limit.context)
      limits.set(model.providerID + "/" + model.id, model.limit.context)
    }
    for (const [agent, alternates] of Object.entries(options.fallback)) {
      if (alternates.length === 0) continue
      const primary = await resolvePrimary(ctx, agent)
      if (primary === undefined) continue
      const primaryLimit = limits.get(primary.key)
      if (primaryLimit === undefined) continue
      for (const alternate of alternates) {
        const alternateLimit = limits.get(alternate.key)
        if (alternateLimit === undefined || alternateLimit >= primaryLimit) continue
        console.warn(
          `openchoreographer: fallback for "${agent}" has a smaller context window than its primary: ${primary.key} allows ${primaryLimit} tokens, ${alternate.key} allows ${alternateLimit}`,
        )
      }
    }
  } catch {
    // Limits are advisory: an unavailable catalog or an unknown model must not block setup.
  }
}
