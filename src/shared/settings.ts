import { SUBAGENT_IDS } from "./agents"
import { parseModel } from "./fallback"

type Animations = { todo: boolean; running: boolean }
export type Ui = { todos: boolean; roster: boolean }
export type ModelSettings = {
  primary: Record<string, string>
  fallback: Record<string, string[]>
}
export type ChoreographerSettings = { animations: Animations; ui: Ui; steps: Record<string, number>; models: ModelSettings }
export type SettingsSnapshot = {
  animations: Animations
  ui: Ui
  steps: Record<string, number>
  defaults: Record<string, number | null>
  managed: string[]
  models: ModelSettings
  configured: Record<string, string | null>
  subagents: string[]
}
export const STEPS_MIN = 1
export const STEPS_MAX = 2000
export const STEPS_STEP = 5
export const SETTINGS_KEY = "settings"

const MODEL_AGENTS_MAX = 32
const MODEL_FALLBACK_MAX = 8
const MODEL_REF_MAX = 200

export function defaultSettings(): ChoreographerSettings {
  return { animations: { todo: true, running: true }, ui: { todos: true, roster: true }, steps: {}, models: { primary: {}, fallback: {} } }
}

export function clampSteps(value: number): number {
  if (!Number.isFinite(value)) return STEPS_MIN
  return Math.min(STEPS_MAX, Math.max(STEPS_MIN, Math.round(value)))
}

// Assignment to one of these keys would mutate the prototype chain instead of the record.
const BLOCKED_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"])

// Model overrides only apply to subagent tool calls. The orchestrator id shares
// the step-budget `managed` set but must never carry a model override.
const SUBAGENT_SET: ReadonlySet<string> = new Set(SUBAGENT_IDS)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validModelKey(key: string): boolean {
  return key.length > 0 && key.length <= 64 && !BLOCKED_KEYS.has(key)
}

function validModelRef(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  if (value.length === 0 || value.length > MODEL_REF_MAX) return undefined
  if (parseModel(value) === undefined) return undefined
  return value
}

function normalizePrimaryRefs(raw: unknown): Record<string, string> {
  const primary: Record<string, string> = {}
  if (!isRecord(raw)) return primary
  for (const [key, entry] of Object.entries(raw)) {
    if (Object.keys(primary).length >= MODEL_AGENTS_MAX) break
    if (!validModelKey(key) || !SUBAGENT_SET.has(key)) continue
    const ref = validModelRef(entry)
    if (ref === undefined) continue
    primary[key] = ref
  }
  return primary
}

function normalizeFallbackRefs(raw: unknown): Record<string, string[]> {
  const fallback: Record<string, string[]> = {}
  if (!isRecord(raw)) return fallback
  for (const [key, entry] of Object.entries(raw)) {
    if (Object.keys(fallback).length >= MODEL_AGENTS_MAX) break
    if (!validModelKey(key) || !SUBAGENT_SET.has(key)) continue
    if (!Array.isArray(entry)) continue
    if (entry.length === 0) {
      fallback[key] = []
      continue
    }
    const refs: string[] = []
    for (const candidate of entry) {
      if (refs.length >= MODEL_FALLBACK_MAX) break
      const ref = validModelRef(candidate)
      if (ref === undefined) continue
      refs.push(ref)
    }
    if (refs.length > 0) fallback[key] = refs
  }
  return fallback
}

function normalizeModels(value: unknown): ModelSettings {
  if (!isRecord(value)) return { primary: {}, fallback: {} }
  return { primary: normalizePrimaryRefs(value.primary), fallback: normalizeFallbackRefs(value.fallback) }
}

export function normalizeSettings(value: unknown, managed?: readonly string[]): ChoreographerSettings {
  if (!isRecord(value)) return defaultSettings()
  const rawAnimations = isRecord(value.animations) ? value.animations : undefined
  const animations: Animations = {
    todo: rawAnimations !== undefined && typeof rawAnimations.todo === "boolean" ? rawAnimations.todo : true,
    running: rawAnimations !== undefined && typeof rawAnimations.running === "boolean" ? rawAnimations.running : true,
  }
  const rawUi = isRecord(value.ui) ? value.ui : undefined
  const ui: Ui = {
    todos: rawUi !== undefined && typeof rawUi.todos === "boolean" ? rawUi.todos : true,
    roster: rawUi !== undefined && typeof rawUi.roster === "boolean" ? rawUi.roster : true,
  }
  const steps: Record<string, number> = {}
  if (isRecord(value.steps)) {
    if (managed !== undefined) {
      for (const key of managed) {
        if (typeof key !== "string" || key.length === 0 || BLOCKED_KEYS.has(key)) continue
        if (!Object.prototype.hasOwnProperty.call(value.steps, key)) continue
        const entry = (value.steps as Record<string, unknown>)[key]
        if (typeof entry !== "number" || !Number.isFinite(entry)) continue
        steps[key] = clampSteps(entry)
      }
    } else {
      let count = 0
      for (const [key, entry] of Object.entries(value.steps)) {
        if (key.length === 0 || key.length > 64 || BLOCKED_KEYS.has(key)) continue
        if (typeof entry !== "number" || !Number.isFinite(entry)) continue
        steps[key] = clampSteps(entry)
        count += 1
        if (count >= 128) break
      }
    }
  }
  const models = normalizeModels(value.models)
  return { animations, ui, steps, models }
}

function normalizeConfigured(value: unknown): Record<string, string | null> {
  const configured: Record<string, string | null> = {}
  if (!isRecord(value)) return configured
  for (const [key, entry] of Object.entries(value)) {
    if (Object.keys(configured).length >= MODEL_AGENTS_MAX) break
    if (!validModelKey(key) || !SUBAGENT_SET.has(key)) continue
    if (entry === null) {
      configured[key] = null
      continue
    }
    const ref = validModelRef(entry)
    if (ref === undefined) continue
    configured[key] = ref
  }
  return configured
}

function defaultSubagents(): string[] {
  return [...SUBAGENT_IDS]
}

export function normalizeSnapshot(value: unknown): SettingsSnapshot | undefined {
  try {
    if (!isRecord(value)) return undefined
    if (!isRecord(value.animations) || !isRecord(value.steps) || !isRecord(value.defaults) || !Array.isArray(value.managed)) return undefined
    const animations = normalizeSettings(value).animations
    const ui = normalizeSettings(value).ui
    const steps = normalizeSettings(value).steps
    const defaults: Record<string, number | null> = {}
    let defaultCount = 0
    for (const [key, entry] of Object.entries(value.defaults)) {
      if (defaultCount >= 128) break
      if (key.length === 0 || key.length > 64 || BLOCKED_KEYS.has(key)) continue
      if (entry === null) {
        defaults[key] = null
        defaultCount += 1
      } else if (typeof entry === "number" && Number.isFinite(entry)) {
        defaults[key] = clampSteps(entry)
        defaultCount += 1
      }
    }
    const managed: string[] = []
    for (const entry of value.managed) {
      if (managed.length >= 32) break
      if (typeof entry !== "string" || entry.length === 0 || entry.length > 64) continue
      managed.push(entry)
    }
    const models = normalizeModels(isRecord(value.models) ? value.models : undefined)
    const configured = normalizeConfigured(isRecord(value.configured) ? value.configured : undefined)
    const subagents = Array.isArray(value.subagents)
      ? (value.subagents as unknown[]).filter((entry): entry is string => typeof entry === "string" && validModelKey(entry)).slice(0, MODEL_AGENTS_MAX)
      : defaultSubagents()
    return { animations, ui, steps, defaults, managed, models, configured, subagents }
  } catch {
    return undefined
  }
}

export function mergeSettings(
  current: ChoreographerSettings,
  patch: unknown,
  managed: readonly string[],
): ChoreographerSettings {
  const animations: Animations = { ...current.animations }
  const ui: Ui = { ...current.ui }
  const steps: Record<string, number> = { ...current.steps }
  const currentModels = current.models ?? { primary: {}, fallback: {} }
  const primary: Record<string, string> = {}
  for (const [key, entry] of Object.entries(currentModels.primary ?? {})) {
    if (!validModelKey(key) || !SUBAGENT_SET.has(key)) continue
    if (typeof entry !== "string") continue
    primary[key] = entry
  }
  const fallback: Record<string, string[]> = {}
  for (const [key, entry] of Object.entries(currentModels.fallback ?? {})) {
    if (!validModelKey(key) || !SUBAGENT_SET.has(key) || !Array.isArray(entry)) continue
    fallback[key] = [...entry]
  }
  if (!isRecord(patch)) return { animations, ui, steps, models: { primary, fallback } }
  if (isRecord(patch.animations)) {
    if (typeof patch.animations.todo === "boolean") animations.todo = patch.animations.todo
    if (typeof patch.animations.running === "boolean") animations.running = patch.animations.running
  }
  if (isRecord(patch.ui)) {
    if (typeof patch.ui.todos === "boolean") ui.todos = patch.ui.todos
    if (typeof patch.ui.roster === "boolean") ui.roster = patch.ui.roster
  }
  if (isRecord(patch.steps)) {
    for (const key of managed) {
      if (typeof key !== "string" || BLOCKED_KEYS.has(key)) continue
      if (!Object.prototype.hasOwnProperty.call(patch.steps, key)) continue
      const entry = (patch.steps as Record<string, unknown>)[key]
      if (entry === null) delete steps[key]
      else if (typeof entry === "number" && Number.isFinite(entry)) steps[key] = clampSteps(entry)
    }
  }
  if (isRecord(patch.models)) {
    if (isRecord(patch.models.primary)) {
      for (const key of SUBAGENT_IDS) {
        if (!Object.prototype.hasOwnProperty.call(patch.models.primary, key)) continue
        const entry = (patch.models.primary as Record<string, unknown>)[key]
        if (entry === null) delete primary[key]
        else {
          const ref = validModelRef(entry)
          if (ref !== undefined) primary[key] = ref
        }
      }
    }
    if (isRecord(patch.models.fallback)) {
      for (const key of SUBAGENT_IDS) {
        if (!Object.prototype.hasOwnProperty.call(patch.models.fallback, key)) continue
        const entry = (patch.models.fallback as Record<string, unknown>)[key]
        if (entry === null) delete fallback[key]
        else if (Array.isArray(entry)) {
          const refs: string[] = []
          for (const candidate of entry) {
            if (refs.length >= MODEL_FALLBACK_MAX) break
            const ref = validModelRef(candidate)
            if (ref === undefined) continue
            refs.push(ref)
          }
          if (entry.length === 0) fallback[key] = []
          else if (refs.length > 0) fallback[key] = refs
        }
      }
    }
  }
  return { animations, ui, steps, models: { primary, fallback } }
}
