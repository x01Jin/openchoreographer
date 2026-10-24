import type { Plugin } from "@opencode/plugin"
import { parseModel, type ParsedModel } from "../shared/fallback"
import type { ModelSettings } from "../shared/settings"

const PRIMARY_TTL_MS = 30_000
const primaryCache = new Map<string, { model: ParsedModel | undefined; at: number }>()

export function formatModelRef(model: ParsedModel): string {
  return model.variant === undefined ? model.key : model.key + "#" + model.variant
}

export function resolveFallbacks(agent: string, overrides?: ModelSettings | undefined): readonly ParsedModel[] {
  if (overrides === undefined || !Object.prototype.hasOwnProperty.call(overrides.fallback, agent)) return []
  const raw = overrides.fallback[agent]
  if (!Array.isArray(raw)) return []
  const parsed: ParsedModel[] = []
  for (const entry of raw) {
    if (parsed.length >= 8) break
    const model = parseModel(entry)
    if (model === undefined) continue
    parsed.push(model)
  }
  return parsed
}

export async function resolvePrimary(ctx: Plugin.Context, agent: string, overrides?: ModelSettings | undefined): Promise<ParsedModel | undefined> {
  if (overrides !== undefined && Object.prototype.hasOwnProperty.call(overrides.primary, agent)) {
    const raw = overrides.primary[agent]
    if (typeof raw === "string") {
      const model = parseModel(raw)
      if (model !== undefined) return model
    }
  }
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

export async function warnNarrowFallbacks(ctx: Plugin.Context, overrides?: ModelSettings | undefined): Promise<void> {
  try {
    const catalog = await ctx.model.list()
    const limits = new Map<string, number>()
    for (const model of catalog.data) {
      // The catalog carries the model id twice; index both so either form resolves a configured key.
      limits.set(model.providerID + "/" + model.modelID, model.limit.context)
      limits.set(model.providerID + "/" + model.id, model.limit.context)
    }
    const agents = new Set<string>(overrides !== undefined ? Object.keys(overrides.fallback) : [])
    for (const agent of agents) {
      const alternates = resolveFallbacks(agent, overrides)
      if (alternates.length === 0) continue
      const primary = await resolvePrimary(ctx, agent, overrides)
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
