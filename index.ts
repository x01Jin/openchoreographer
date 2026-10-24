import { Plugin } from "@opencode/plugin"
import { AGENT_IDS, STEP_DEFAULTS, SUBAGENT_IDS } from "./src/shared/agents"
import { normalizeOptions } from "./src/shared/options"
import { ChoreographerRpc } from "./src/shared/rpc"
import { SETTINGS_KEY, clampSteps, defaultSettings, mergeSettings, normalizeSettings, type ModelSettings, type SettingsSnapshot } from "./src/shared/settings"
import { agentDirs, agentStepsPath, disableAgentFile, enableAgentFile, readAgentSteps, syncAgentFiles, syncOrchestratorRules, syncTeamLines, writeAgentSteps } from "./src/server/agent-files"
import { warnNarrowFallbacks } from "./src/server/models"
import { diffTool } from "./src/server/tools/diff"
import { todoTools } from "./src/server/tools/todos"
import { fallbackStatusTool } from "./src/server/tools/fallback-status"
import { commands } from "./src/server/commands"
import { contextHook } from "./src/server/context"
import { breaker, resetFallbackWrapper, retryHook, subagentAfterHook, subagentBeforeHook, subagentTransform } from "./src/server/fallback"

type Registration = { dispose: () => Promise<void> }

let active: Registration[] = []
let epoch = 0

export default Plugin.define({
  id: "openchoreographer",
  async setup(ctx) {
    const generation = ++epoch
    resetFallbackWrapper()
    const previous = active
    active = []
    await Promise.allSettled(previous.map((registration) => registration.dispose()))
    const options = normalizeOptions(ctx.options)
    // 1.2.0 accepted a `fallback` object here. It is gone, but an upgrade leaves the key in
    // opencode.jsonc where it would otherwise vanish without explanation.
    if (typeof ctx.options === "object" && ctx.options !== null && Object.prototype.hasOwnProperty.call(ctx.options, "fallback")) {
      console.warn('openchoreographer: the "fallback" plugin option is ignored; configure fallback models in /choreographer')
    }
    const registrations: Registration[] = []
    const managedIds = [...new Set([options.agent, ...AGENT_IDS])].filter((id) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id))
    const subagents = SUBAGENT_IDS
    let reloadTimer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    const scheduleReload = () => {
      if (reloadTimer !== undefined) return
      reloadTimer = setTimeout(() => {
        reloadTimer = undefined
        if (disposed) return
        void ctx.agent.reload().catch((error) => console.warn(`openchoreographer: agent reload failed: ${error instanceof Error ? error.message : String(error)}`))
      }, 50)
    }
    try {
      let stored: unknown = undefined
      let storedOk = true
      try {
        stored = await ctx.storage.get(SETTINGS_KEY)
      } catch (error) {
        console.warn(`openchoreographer: settings unavailable, using defaults: ${error instanceof Error ? error.message : String(error)}`)
        storedOk = false
        stored = defaultSettings()
      }
      // The file is the source of step values and STEP_DEFAULTS is only the reset target, so a step override saved
      // under the old model is stale and would mask the new defaults. Clear those overrides once; ui and animations survive.
      let settingsVersion: unknown = undefined
      try {
        settingsVersion = await ctx.storage.get("settingsVersion")
      } catch {
        settingsVersion = undefined
      }
      const normalized = normalizeSettings(stored, managedIds)
      if (settingsVersion !== 3) {
        normalized.steps = {}
        if (storedOk) {
          try {
            await ctx.storage.set(SETTINGS_KEY, normalized)
            await ctx.storage.set("settingsVersion", 3)
          } catch (error) {
            console.warn(`openchoreographer: settings migration failed, using defaults: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
      const settings = { current: normalized }
      const getModels = (): ModelSettings => settings.current.models
      const getDisabled = (): string[] => settings.current.disabled
      const dirs = agentDirs(ctx.location)
      if (!storedOk) {
        console.warn("openchoreographer: settings unavailable, skipping agent file sync")
      } else {
        try {
          const synced = syncAgentFiles(dirs, settings.current.disabled)
          const orchestratorRules = syncOrchestratorRules(dirs, settings.current.disabled)
          const teams = syncTeamLines(dirs, settings.current.disabled)
          if (synced || orchestratorRules || teams) scheduleReload()
        } catch (error) {
          console.warn(`openchoreographer: agent file sync failed: ${error instanceof Error ? error.message : String(error)}`)
          scheduleReload()
        }
      }
      let fileSteps: Record<string, number> = {}
      for (const id of managedIds) {
        const value = readAgentSteps(dirs, id)
        if (value !== null) fileSteps[id] = value
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
        return {
          animations: settings.current.animations,
          ui: settings.current.ui,
          steps: { ...fileSteps },
          defaults: Object.fromEntries(managedIds.map((id) => [id, STEP_DEFAULTS[id] ?? null])),
          managed: managedIds,
          models,
          configured: await loadConfigured(),
          subagents: [...subagents],
          disabled: [...settings.current.disabled],
          maxParallel: settings.current.maxParallel,
        }
      }
      let emitUpdated: ((snap: SettingsSnapshot) => Promise<void>) | undefined
      const rpc = await ctx.rpc.register(ChoreographerRpc, {
        getSettings: async () => {
          const next: Record<string, number> = {}
          for (const id of managedIds) {
            const value = readAgentSteps(dirs, id)
            if (value !== null) next[id] = value
          }
          fileSteps = next
          return snapshot()
        },
        setSettings: async (input) => {
          const next = mergeSettings(settings.current, input, managedIds)
          const patch = (typeof input === "object" && input !== null ? input : undefined) as { steps?: unknown; disabled?: unknown } | undefined
          if (patch !== undefined && patch.steps !== null && typeof patch.steps === "object" && !Array.isArray(patch.steps)) {
            const stepsPatch = patch.steps as Record<string, unknown>
            const targets: { id: string; path: string; value: number }[] = []
            for (const id of managedIds) {
              const raw = stepsPatch[id]
              const value =
                raw === null ? STEP_DEFAULTS[id] : typeof raw === "number" ? clampSteps(raw) : undefined
              if (value === undefined) continue
              const path = agentStepsPath(dirs, id)
              if (path === undefined) throw new Error("openchoreographer: agent file not found or unsafe")
              targets.push({ id, path, value })
            }
            for (const target of targets) {
              writeAgentSteps(dirs, target.id, target.value)
              fileSteps[target.id] = target.value
            }
            scheduleReload()
          }
          if (patch !== undefined && Array.isArray(patch.disabled)) {
            const oldDisabled = settings.current.disabled
            const oldSet = new Set(oldDisabled)
            const nextSet = new Set(next.disabled)
            const added = next.disabled.filter((id) => !oldSet.has(id))
            const removed = oldDisabled.filter((id) => !nextSet.has(id))
            const appliedAdded: string[] = []
            const appliedRemoved: string[] = []
            let filesChanged = false
            try {
              for (const id of added) {
                if (disableAgentFile(dirs, id)) filesChanged = true
                appliedAdded.push(id)
              }
              for (const id of removed) {
                if (enableAgentFile(dirs, id)) filesChanged = true
                appliedRemoved.push(id)
              }
              if (syncOrchestratorRules(dirs, next.disabled)) filesChanged = true
              if (syncTeamLines(dirs, next.disabled)) filesChanged = true
              if (filesChanged) scheduleReload()
            } catch (error) {
              for (const id of appliedAdded) {
                try {
                  enableAgentFile(dirs, id)
                } catch {
                  // Revert is best-effort; the original error below is what matters.
                }
              }
              for (const id of appliedRemoved) {
                try {
                  disableAgentFile(dirs, id)
                } catch {
                  // Revert is best-effort; the original error below is what matters.
                }
              }
              try {
                syncOrchestratorRules(dirs, oldDisabled)
              } catch {
                // Revert is best-effort; the original error below is what matters.
              }
              try {
                syncTeamLines(dirs, oldDisabled)
              } catch {
                // Revert is best-effort; the original error below is what matters.
              }
              throw error
            }
          }
          settings.current = next
          settings.current.steps = {}
          await ctx.storage.set(SETTINGS_KEY, settings.current)
          const snap = await snapshot()
          if (emitUpdated) await emitUpdated(snap)
          return snap
        },
      })
      registrations.push(rpc)
      emitUpdated = (snap) => rpc.events.emit("updated", snap)
      registrations.push(await retryHook(ctx, getModels))

      registrations.push(await subagentBeforeHook(ctx, getModels, getDisabled))

      registrations.push(await subagentAfterHook(ctx))

      registrations.push(await subagentTransform(ctx, getModels, getDisabled))

      const listed = await ctx.agent.list({ location: ctx.location }).catch(() => undefined)
      if (listed) {
        const ids = listed.data.map((agent) => agent.id)
        const missing = ids.length > 0 ? AGENT_IDS.filter((id) => !ids.includes(id) && !settings.current.disabled.includes(id)) : []
        if (missing.length > 0) {
          console.warn("openchoreographer: agent definitions not registered: " + missing.join(", ") + ". Run: node bin/install.mjs --force, then restart OpenCode.")
        }
      } else {
        console.warn("openchoreographer: agent list unavailable, skipping setup validation")
      }

      // Context-window limits are advisory; a catalog read must never break setup.
      if (Object.keys(settings.current.models.fallback).length > 0) void warnNarrowFallbacks(ctx, getModels()).catch(() => undefined)

      registrations.push(await diffTool(ctx))

      registrations.push(await todoTools(ctx))

      registrations.push(await fallbackStatusTool(ctx, breaker, getModels))

      registrations.push(await commands(ctx, options, getDisabled))

      registrations.push(await contextHook(ctx, options, getDisabled, () => settings.current.maxParallel))

      if (generation !== epoch) {
        const stale = [...registrations].reverse()
        registrations.length = 0
        await Promise.allSettled(stale.map((registration) => registration.dispose()))
        return
      }
      active = registrations
      return async () => {
        disposed = true
        if (reloadTimer !== undefined) {
          clearTimeout(reloadTimer)
          reloadTimer = undefined
        }
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
