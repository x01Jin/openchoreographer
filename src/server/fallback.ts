import type { Plugin } from "@opencode/plugin"
import { chooseModel, createBreaker, isChildQuotaFailure, isQuotaError, parseModel, planResultFallback, planRetriedResult } from "../shared/fallback"
import { clipResultStats } from "../shared/results"
import type { ModelSettings } from "../shared/settings"
import { formatModelRef, resolveFallbacks, resolvePrimary } from "./models"
import { changedFiles, changedTreeError, readTree, treeKey } from "./tree"

const breaker = createBreaker({ initialMs: 5 * 60_000, maxMs: 60 * 60_000 })
let wrapperInstalled = false

export function resetFallbackWrapper(): void {
  wrapperInstalled = false
}

export { breaker }

export function retryHook(ctx: Plugin.Context, getModels: () => ModelSettings) {
  return ctx.session.hook("retry", (event) => {
    if (!isQuotaError(event.error)) return
    // The host Model.Ref splits provider and id, so rejoin them for breaker accounting.
    const current = parseModel(event.model.providerID + "/" + event.model.id + (event.model.variant ? "#" + event.model.variant : ""))
    if (current === undefined) return
    breaker.fail(current, { retryAfterMs: event.error.retryAfterMs })
    const alternates = resolveFallbacks(event.agent, getModels())
    // Only suppress the host retry when the wrapper can actually route to a fallback.
    if (alternates !== undefined && alternates.length > 0 && wrapperInstalled) event.decision = { retry: false }
  })
}

export function subagentBeforeHook(ctx: Plugin.Context, getModels: () => ModelSettings) {
  return ctx.tool.hook("execute.before", async (event) => {
    if (event.tool !== "subagent") return
    if (typeof event.input !== "object" || event.input === null) return
    // The subagent input shape is host-defined, so narrow it once to read fields.
    const record = event.input as Record<string, unknown>
    if (typeof record.agent !== "string") return
    const agent = record.agent
    const overrides = getModels()
    const alternates = resolveFallbacks(agent, overrides)
    const configured = await resolvePrimary(ctx, agent, overrides)
    const raw = record.model
    const requested = typeof raw === "string" ? parseModel(raw) : undefined
    if (requested !== undefined) {
      if (breaker.available(requested)) return
      const choice = chooseModel({ primary: requested, alternates, available: (m) => breaker.available(m) })
      if (choice.model !== undefined && choice.fellBack) {
        record.model = formatModelRef(choice.model)
      }
      return
    }
    if (configured === undefined) return
    const choice = chooseModel({ primary: configured, alternates, available: (m) => breaker.available(m) })
    if (choice.model === undefined) return
    if (choice.fellBack) {
      record.model = formatModelRef(choice.model)
      return
    }
    const hasOverride = Object.prototype.hasOwnProperty.call(overrides.primary, agent)
    if (hasOverride && record.model !== formatModelRef(choice.model)) {
      record.model = formatModelRef(choice.model)
    }
  })
}

export function subagentAfterHook(ctx: Plugin.Context) {
  return ctx.tool.hook("execute.after", (event) => {
    if (event.tool !== "subagent" || event.status !== "completed") return
    // Clipping is best-effort: a mutation failure must never turn a finished call into an error.
    try {
      const result = event.result
      if (typeof result.content === "string") {
        const text = result.content
        const clipped = clipResultStats(text)
        if (clipped.text === text) return
        event.result = {
          ...result,
          content: clipped.text,
          metadata: { ...result.metadata, resultBudget: { dropped: clipped.dropped } },
        }
        return
      }
      if (!Array.isArray(result.content)) return
      let dropped = 0
      const content = result.content.map((entry) => {
        if (entry.type !== "text") return entry
        const clipped = clipResultStats(entry.text)
        if (clipped.text === entry.text) return entry
        dropped += clipped.dropped
        return { ...entry, text: clipped.text }
      })
      if (dropped === 0) return
      event.result = { ...result, content, metadata: { ...result.metadata, resultBudget: { dropped } } }
    } catch (error) {
      console.warn(`openchoreographer: result budget skipped for a subagent result: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

export function subagentTransform(ctx: Plugin.Context, getModels: () => ModelSettings) {
  return ctx.tool.transform((editor) => {
    const target = editor.get("subagent")
    if (target === undefined || typeof target.execute !== "function") return
    editor.update("subagent", (tool) => {
      const original = target.execute
      tool.execute = async (input, context) => {
        // The subagent input shape is host-defined, so narrow it once to read fields.
        const fields = input as Record<string, unknown>
        const startedAt = Date.now()
        const agent = typeof fields.agent === "string" ? fields.agent : undefined
        const overrides = getModels()
        const alternatesForAgent = agent !== undefined ? resolveFallbacks(agent, overrides) : []
        const used =
          typeof fields.model === "string"
            ? parseModel(fields.model)
            : agent === undefined
              ? undefined
              : await resolvePrimary(ctx, agent, overrides)
        let baseline: ReadonlySet<string> | undefined
        let spawn = input
        if (agent !== undefined && fields.model === undefined && Object.prototype.hasOwnProperty.call(overrides.primary, agent)) {
          const parsed = parseModel(overrides.primary[agent])
          if (parsed !== undefined) {
            const ref = formatModelRef(parsed)
            fields.model = ref
            spawn = { ...fields, model: ref }
          }
        }
        try {
          // The baseline is status-based: a file already dirty at spawn and edited further is not detected.
          if (agent !== undefined && alternatesForAgent.length > 0) {
            const tree = await readTree(ctx)
            if (tree !== undefined) baseline = new Set(tree.map(treeKey))
          }
          const result = await original(spawn, context)
          const actual = typeof fields.model === "string" ? parseModel(fields.model) : used
          const plan = planResultFallback({
            result,
            actual,
            alternates: alternatesForAgent,
            available: (m) => breaker.available(m),
            aborted: context.signal.aborted,
          })
          if (plan.kind === "return") {
            if (plan.credit !== undefined) breaker.succeed(plan.credit, startedAt)
            else if (actual !== undefined && isChildQuotaFailure(result)) breaker.fail(actual)
            return result
          }
          if (agent !== undefined) {
            const alternates = alternatesForAgent
            if (alternates.length > 0) {
              if (plan.fail !== undefined) breaker.fail(plan.fail)
              const alternate = plan.model
              if (baseline !== undefined) {
                const current = await readTree(ctx, true)
                if (current !== undefined) {
                  const changed = changedFiles(baseline, current)
                  if (changed.length > 0) return result
                }
              }
              const next = formatModelRef(alternate)
              try {
                const retried = await original({ ...fields, model: next }, context)
                const settled = planRetriedResult({ result: retried, alternate })
                if (settled.fail !== undefined) breaker.fail(settled.fail)
                if (settled.credit !== undefined) breaker.succeed(settled.credit, startedAt)
                return retried
              } catch (retryError) {
                breaker.fail(alternate)
                throw retryError
              }
            }
          }
          return result
        } catch (error) {
          // A cancelled child is not a provider failure; retrying would ignore the abort.
          if (context.signal.aborted) throw error
          const message = error instanceof Error ? error.message : String(error)
          if (/abort|cancel/i.test(message)) throw error
          if (agent === undefined) throw error
          const alternates = alternatesForAgent
          const actual = typeof fields.model === "string" ? parseModel(fields.model) : used
          const failed = actual ?? used
          if (failed === undefined || alternates === undefined || alternates.length === 0) throw error
          if (!isQuotaError({ message }) && breaker.available(failed)) throw error
          breaker.fail(failed)
          const choice = chooseModel({ primary: failed, alternates, available: (m) => breaker.available(m) })
          if (!choice.fellBack || choice.model === undefined) throw error
          // Never resend the model that just failed, and never route to an exhausted one.
          if (choice.model.key === failed.key || !breaker.available(choice.model)) throw error
          // Do not pay twice for a failed spawn; a tree we could not read either time retries exactly as before.
          if (baseline !== undefined) {
            const current = await readTree(ctx, true)
            if (current !== undefined) {
              const changed = changedFiles(baseline, current)
              if (changed.length > 0) throw changedTreeError(error, changed)
            }
          }
          const alternate = formatModelRef(choice.model)
          try {
            const result = await original({ ...fields, model: alternate }, context)
            breaker.succeed(choice.model, startedAt)
            return result
          } catch (retryError) {
            breaker.fail(choice.model)
            throw retryError
          }
        }
      }
    })
    wrapperInstalled = true
  })
}
