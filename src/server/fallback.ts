import type { Plugin } from "@opencode/plugin"
import { chooseModel, classifyFailure, createModelHealth, FALLBACK_WINDOW_MS, isChildFailure, isChildQuotaFailure, parseModel, planRetriedResult, planRetryDecision } from "../shared/fallback"
import { clipResultStats } from "../shared/results"
import type { ModelSettings } from "../shared/settings"
import { formatModelRef, resolveFallbacks, resolvePrimary } from "./models"
import { changedFiles, changedTreeError, readTree, treeKey } from "./tree"

let healthListener: (() => void) | undefined

export function onHealthChange(fn: () => void): void {
  healthListener = fn
}

export const health = createModelHealth({
  windowMs: FALLBACK_WINDOW_MS,
  onChange: () => {
    healthListener?.()
  },
})

export function retryHook(ctx: Plugin.Context, getModels: () => ModelSettings) {
  return ctx.session.hook("retry", (event) => {
    const alternates = resolveFallbacks(event.agent, getModels())
    // An agent without configured fallbacks keeps the host behavior untouched.
    if (alternates.length === 0) return
    // The host Model.Ref splits provider and id, so rejoin them for health accounting.
    const current = parseModel(event.model.providerID + "/" + event.model.id + (event.model.variant ? "#" + event.model.variant : ""))
    if (current === undefined) return
    const plan = planRetryDecision({ error: event.error, attempt: event.attempt, degraded: health.degraded(current), hasFallback: true })
    if (plan.kind === "retry") {
      health.degrade(current)
      event.decision = { retry: true, delay: plan.delayMs }
    } else if (plan.kind === "fallback") {
      health.fail(current, plan.mark)
      event.decision = { retry: false }
    } else {
      event.decision = { retry: false }
    }
  })
}

export function subagentBeforeHook(ctx: Plugin.Context, getModels: () => ModelSettings, getDisabled: () => readonly string[] = () => []) {
  return ctx.tool.hook("execute.before", async (event) => {
    if (event.tool !== "subagent") return
    if (typeof event.input !== "object" || event.input === null) return
    // The subagent input shape is host-defined, so narrow it once to read fields.
    const record = event.input as Record<string, unknown>
    if (typeof record.agent !== "string") return
    const agent = record.agent
    if (getDisabled().includes(agent)) throw new Error(`openchoreographer: subagent "${agent}" is disabled in /choreographer; enable it there or delegate to an enabled agent`)
    const overrides = getModels()
    const alternates = resolveFallbacks(agent, overrides)
    const configured = await resolvePrimary(ctx, agent, overrides)
    const raw = record.model
    const requested = typeof raw === "string" ? parseModel(raw) : undefined
    if (requested !== undefined) {
      if (!health.down(requested)) return
      const choice = chooseModel({ primary: requested, alternates, available: (m) => !health.down(m) })
      if (choice.model !== undefined && choice.fellBack) {
        record.model = formatModelRef(choice.model)
      }
      return
    }
    if (configured === undefined) return
    const choice = chooseModel({ primary: configured, alternates, available: (m) => !health.down(m) })
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function subagentTransform(ctx: Plugin.Context, getModels: () => ModelSettings, getDisabled: () => readonly string[] = () => []) {
  return ctx.tool.transform((editor) => {
    const target = editor.get("subagent")
    if (target === undefined || typeof target.execute !== "function") return
    editor.update("subagent", (tool) => {
      const original = target.execute
      tool.execute = async (input, context) => {
        // The subagent input shape is host-defined, so narrow it once to read fields.
        const fields = input as Record<string, unknown>
        const agent = typeof fields.agent === "string" ? fields.agent : undefined
        if (agent !== undefined && getDisabled().includes(agent)) throw new Error(`openchoreographer: subagent "${agent}" is disabled in /choreographer; enable it there or delegate to an enabled agent`)
        const startedAt = Date.now()
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
          const aborted = context.signal.aborted
          const failedResult = !aborted && isChildFailure(result)
          const quota = failedResult && isChildQuotaFailure(result)
          if (quota && actual !== undefined) health.fail(actual, "quota")
          if (failedResult && actual !== undefined && health.down(actual) && alternatesForAgent.length > 0) {
            const candidates = alternatesForAgent.filter((m) => m.key !== actual.key)
            if (candidates.length > 0) {
              const alternate = candidates.find((m) => !health.down(m)) ?? candidates[candidates.length - 1]
              if (baseline !== undefined) {
                const current = await readTree(ctx, true)
                if (current !== undefined) {
                  const changed = changedFiles(baseline, current)
                  if (changed.length > 0) return result
                }
              }
              const next = formatModelRef(alternate)
              if (agent !== undefined && getDisabled().includes(agent)) throw new Error(`openchoreographer: subagent "${agent}" is disabled in /choreographer; enable it there or delegate to an enabled agent`)
              try {
                const retried = await original({ ...fields, model: next }, context)
                const settled = planRetriedResult({ result: retried, alternate })
                if (settled.fail !== undefined) health.fail(settled.fail, "quota")
                if (settled.credit !== undefined) health.succeed(settled.credit, startedAt)
                return retried
              } catch (retryError) {
                const retryKind = classifyFailure({ message: errorMessage(retryError) })
                if (retryKind !== "fatal") health.fail(alternate, retryKind === "quota" ? "quota" : "retries")
                throw retryError
              }
            }
          }
          if (!aborted && !failedResult && actual !== undefined) health.succeed(actual, startedAt)
          return result
        } catch (error) {
          if (agent !== undefined && getDisabled().includes(agent)) throw error
          // A cancelled child is not a provider failure; retrying would ignore the abort.
          if (context.signal.aborted) throw error
          const message = errorMessage(error)
          if (/abort|cancel/i.test(message)) throw error
          if (agent === undefined) throw error
          const actual = typeof fields.model === "string" ? parseModel(fields.model) : used
          const failed = actual ?? used
          if (failed === undefined || alternatesForAgent.length === 0) throw error
          const kind = classifyFailure({ message })
          if (kind === "fatal") throw error
          health.fail(failed, kind === "quota" ? "quota" : "retries")
          const choice = chooseModel({ primary: failed, alternates: alternatesForAgent, available: (m) => !health.down(m) })
          if (!choice.fellBack || choice.model === undefined) throw error
          // Never resend the model that just failed; the choice may be the last resort even when exhausted.
          if (choice.model.key === failed.key) throw error
          // Do not pay twice for a failed spawn; a tree we could not read either time retries exactly as before.
          if (baseline !== undefined) {
            const current = await readTree(ctx, true)
            if (current !== undefined) {
              const changed = changedFiles(baseline, current)
              if (changed.length > 0) throw changedTreeError(error, changed)
            }
          }
          const alternate = formatModelRef(choice.model)
          if (agent !== undefined && getDisabled().includes(agent)) throw new Error(`openchoreographer: subagent "${agent}" is disabled in /choreographer; enable it there or delegate to an enabled agent`)
          try {
            const result = await original({ ...fields, model: alternate }, context)
            health.succeed(choice.model, startedAt)
            return result
          } catch (retryError) {
            const retryKind = classifyFailure({ message: errorMessage(retryError) })
            if (retryKind !== "fatal") health.fail(choice.model, retryKind === "quota" ? "quota" : "retries")
            throw retryError
          }
        }
      }
    })
  })
}
