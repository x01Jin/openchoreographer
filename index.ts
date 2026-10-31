import { Plugin } from "@opencode/plugin"
import { AGENT_IDS, SUBAGENT_IDS } from "./src/shared/agents"
import { chooseModel } from "./src/shared/fallback"
import { normalizeOptions } from "./src/shared/options"
import { ChoreographerRpc } from "./src/shared/rpc"
import { SETTINGS_KEY, defaultSettings, mergeSettings, normalizeSettings, type ModelSettings, type SettingsSnapshot } from "./src/shared/settings"
import { registerChoreographerAgents } from "./src/server/agent-source"
import { formatModelRef, resolveFallbacks, resolvePrimary, warnNarrowFallbacks } from "./src/server/models"
import { diffTool } from "./src/server/tools/diff"
import { todoTools } from "./src/server/tools/todos"
import { fallbackStatusTool } from "./src/server/tools/fallback-status"
import { commands } from "./src/server/commands"
import { contextHook } from "./src/server/context"
import { health, onHealthChange, retryHook, subagentAfterHook, subagentBeforeHook, subagentTransform } from "./src/server/fallback"
import { outputClipHook } from "./src/server/output"

type Registration = { dispose: () => Promise<void> }

let active: Registration[] = []
let epoch = 0

export default Plugin.define({
  id: "openchoreographer",
  async setup(ctx) {
    const generation = ++epoch
    const previous = active
    active = []
    await Promise.allSettled(previous.map((registration) => registration.dispose()))
    const options = normalizeOptions(ctx.options)
    if (typeof ctx.options === "object" && ctx.options !== null && Object.prototype.hasOwnProperty.call(ctx.options, "fallback")) {
      console.warn('openchoreographer: the "fallback" plugin option is ignored; configure fallback models in /choreographer')
    }
    const registrations: Registration[] = []
    const subagents = SUBAGENT_IDS
    let disposed = false
    try {
      let stored: unknown = undefined
      try {
        stored = await ctx.storage.get(SETTINGS_KEY)
      } catch (error) {
        console.warn(`openchoreographer: settings unavailable, using defaults: ${error instanceof Error ? error.message : String(error)}`)
        stored = defaultSettings()
      }
      const normalized = normalizeSettings(stored)
      const settings = { current: normalized }
      const getModels = (): ModelSettings => settings.current.models
      try {
        registrations.push(await registerChoreographerAgents(ctx))
      } catch (error) {
        console.warn(`openchoreographer: agent registration failed: ${error instanceof Error ? error.message : String(error)}`)
      }

      const loadConfigured = async (): Promise<Record<string, string | null>> => {
        const configured: Record<string, string | null> = {}
        for (const id of subagents) configured[id] = null
        try {
          const listed = await ctx.agent.list({ location: ctx.location })
          for (const id of subagents) {
            const found = listed.data.find((a) => a.id === id)
            configured[id] =
              found?.model !== undefined
                ? found.model.providerID + "/" + found.model.id + (found.model.variant ? "#" + found.model.variant : "")
                : null
          }
        } catch {
          // An unavailable agent list must not break settings; nulls already mark every subagent.
        }
        return configured
      }
      const snapshot = async (): Promise<SettingsSnapshot> => {
        const models: ModelSettings = {
          primary: { ...settings.current.models.primary },
          fallback: Object.fromEntries(Object.entries(settings.current.models.fallback).map(([id, refs]) => [id, [...refs]])),
        }
        const overrides = settings.current.models
        const routing: Record<string, { model: string; fallback: boolean }> = {}
        for (const id of subagents) {
          const primary = await resolvePrimary(ctx, id, overrides)
          const fallbacks = resolveFallbacks(id, overrides)
          const choice = chooseModel({ primary, alternates: fallbacks, available: (m) => !health.down(m) })
          if (choice.model !== undefined) routing[id] = { model: formatModelRef(choice.model), fallback: choice.fellBack }
        }
        return {
          animations: settings.current.animations,
          ui: settings.current.ui,
          models,
          configured: await loadConfigured(),
          subagents: [...subagents],
          maxParallel: settings.current.maxParallel,
          routing,
        }
      }
      let emitUpdated: ((snap: SettingsSnapshot) => Promise<void>) | undefined
      const rpc = await ctx.rpc.register(ChoreographerRpc, {
        getSettings: async () => {
          return snapshot()
        },
        setSettings: async (input) => {
          settings.current = mergeSettings(settings.current, input)
          await ctx.storage.set(SETTINGS_KEY, settings.current)
          const snap = await snapshot()
          if (emitUpdated) await emitUpdated(snap)
          return snap
        },
        resetModel: async (input) => {
          const agent = (typeof input === "object" && input !== null ? (input as { agent?: unknown }).agent : undefined)
          if (typeof agent !== "string" || !SUBAGENT_IDS.includes(agent)) throw new Error("openchoreographer: unknown subagent")
          const overrides = settings.current.models
          const primary = await resolvePrimary(ctx, agent, overrides)
          const fallbacks = resolveFallbacks(agent, overrides)
          health.reset([...(primary === undefined ? [] : [primary]), ...fallbacks])
          const snap = await snapshot()
          if (emitUpdated) await emitUpdated(snap)
          return snap
        },
      })
      registrations.push(rpc)
      emitUpdated = (snap) => rpc.events.emit("updated", snap)
      let healthTimer: ReturnType<typeof setTimeout> | undefined
      let expiryTimer: ReturnType<typeof setTimeout> | undefined
      const clearExpiryTimer = () => {
        if (expiryTimer !== undefined) {
          clearTimeout(expiryTimer)
          expiryTimer = undefined
        }
      }
      const scheduleExpiryRefresh = () => {
        clearExpiryTimer()
        let wait = 0
        try {
          for (const row of health.snapshot()) {
            if (row.waitMs > wait) wait = row.waitMs
          }
        } catch (error) {
          console.warn(`openchoreographer: routing refresh failed: ${error instanceof Error ? error.message : String(error)}`)
          return
        }
        if (wait <= 0) return
        expiryTimer = setTimeout(() => {
          expiryTimer = undefined
          if (disposed) return
          void snapshot()
            .then((snap) => rpc.events.emit("updated", snap))
            .then(() => {
              scheduleExpiryRefresh()
            })
            .catch((error) => console.warn(`openchoreographer: routing refresh failed: ${error instanceof Error ? error.message : String(error)}`))
        }, wait + 250)
      }
      onHealthChange(() => {
        if (healthTimer !== undefined) return
        healthTimer = setTimeout(() => {
          healthTimer = undefined
          if (disposed) return
          void snapshot()
            .then((snap) => rpc.events.emit("updated", snap))
            .then(() => {
              scheduleExpiryRefresh()
            })
            .catch((error) => console.warn(`openchoreographer: routing refresh failed: ${error instanceof Error ? error.message : String(error)}`))
        }, 100)
      })
      registrations.push(await retryHook(ctx, getModels))

      registrations.push(await subagentBeforeHook(ctx, getModels))

      registrations.push(await subagentAfterHook(ctx))

      registrations.push(await outputClipHook(ctx))

      registrations.push(await subagentTransform(ctx, getModels))

      const listed = await ctx.agent.list({ location: ctx.location }).catch(() => undefined)
      if (listed) {
        const ids = listed.data.map((agent) => agent.id)
        const missing = ids.length > 0 ? AGENT_IDS.filter((id) => !ids.includes(id)) : []
        if (missing.length > 0) {
          console.warn("openchoreographer: agent definitions not registered: " + missing.join(", ") + ". Restart OpenCode or run /reload.")
        }
      } else {
        console.warn("openchoreographer: agent list unavailable, skipping setup validation")
      }

      // Context-window limits are advisory; a catalog read must never break setup.
      if (Object.keys(settings.current.models.fallback).length > 0) void warnNarrowFallbacks(ctx, getModels()).catch(() => undefined)

      registrations.push(await diffTool(ctx))

      registrations.push(await todoTools(ctx))

      registrations.push(await fallbackStatusTool(ctx, health, getModels))

      registrations.push(await commands(ctx, options))

      registrations.push(await contextHook(ctx, options, () => settings.current.maxParallel))

      if (generation !== epoch) {
        const stale = [...registrations].reverse()
        registrations.length = 0
        if (healthTimer !== undefined) {
          clearTimeout(healthTimer)
          healthTimer = undefined
        }
        clearExpiryTimer()
        await Promise.allSettled(stale.map((registration) => registration.dispose()))
        return
      }
      active = registrations
      return async () => {
        disposed = true
        if (healthTimer !== undefined) {
          clearTimeout(healthTimer)
          healthTimer = undefined
        }
        clearExpiryTimer()
        const pending = [...registrations].reverse()
        registrations.length = 0
        if (active === registrations) {
          active = []
        }
        for (const [index, registration] of pending.entries()) {
          try {
            await registration.dispose()
          } catch (error) {
            console.warn(`openchoreographer: dispose failed for registration ${index}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
    } catch (error) {
      const pending = [...registrations].reverse()
      registrations.length = 0
      await Promise.allSettled(pending.map((registration) => registration.dispose()))
      throw error
    }
  },
})
