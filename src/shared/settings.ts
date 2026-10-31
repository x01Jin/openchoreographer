import { SUBAGENT_IDS } from "./agents"
import { parseModel } from "./fallback"

type Animations = { todo: boolean; running: boolean }
export type Ui = { todos: boolean; roster: boolean }
export type ModelSettings = {
  primary: Record<string, string>
  fallback: Record<string, string[]>
}
export type ChoreographerSettings = { animations: Animations; ui: Ui; models: ModelSettings; maxParallel: number }
export type SettingsSnapshot = {
  animations: Animations
  ui: Ui
  models: ModelSettings
  configured: Record<string, string | null>
  subagents: string[]
  maxParallel: number
  routing: Record<string, { model: string; fallback: boolean }>
}
export const PARALLEL_MIN = 1
export const PARALLEL_MAX = 8
export const PARALLEL_DEFAULT = 4
export const SETTINGS_KEY = "settings"

const MODEL_AGENTS_MAX = 32
const MODEL_FALLBACK_MAX = 8
const MODEL_REF_MAX = 200

export function defaultSettings(): ChoreographerSettings {
  return { animations: { todo: true, running: true }, ui: { todos: false, roster: true }, models: { primary: {}, fallback: {} }, maxParallel: PARALLEL_DEFAULT }
}

const BLOCKED_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"])
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

export function normalizeMaxParallel(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return PARALLEL_DEFAULT
  return Math.min(PARALLEL_MAX, Math.max(PARALLEL_MIN, Math.floor(value)))
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

export function normalizeSettings(value: unknown): ChoreographerSettings {
  if (!isRecord(value)) return defaultSettings()
  const rawAnimations = isRecord(value.animations) ? value.animations : undefined
  const animations: Animations = {
    todo: rawAnimations !== undefined && typeof rawAnimations.todo === "boolean" ? rawAnimations.todo : true,
    running: rawAnimations !== undefined && typeof rawAnimations.running === "boolean" ? rawAnimations.running : true,
  }
  const rawUi = isRecord(value.ui) ? value.ui : undefined
  const ui: Ui = {
    todos: rawUi !== undefined && typeof rawUi.todos === "boolean" ? rawUi.todos : false,
    roster: rawUi !== undefined && typeof rawUi.roster === "boolean" ? rawUi.roster : true,
  }
  const models = normalizeModels(value.models)
  const maxParallel = normalizeMaxParallel(value.maxParallel)
  return { animations, ui, models, maxParallel }
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

function normalizeRouting(value: unknown): Record<string, { model: string; fallback: boolean }> {
  const routing: Record<string, { model: string; fallback: boolean }> = {}
  if (!isRecord(value)) return routing
  for (const [key, entry] of Object.entries(value)) {
    if (Object.keys(routing).length >= MODEL_AGENTS_MAX) break
    if (!validModelKey(key) || !SUBAGENT_SET.has(key)) continue
    if (!isRecord(entry)) continue
    const ref = validModelRef(entry.model)
    if (ref === undefined) continue
    if (typeof entry.fallback !== "boolean") continue
    routing[key] = { model: ref, fallback: entry.fallback }
  }
  return routing
}

export function normalizeSnapshot(value: unknown): SettingsSnapshot | undefined {
  try {
    if (!isRecord(value)) return undefined
    if (!isRecord(value.animations)) return undefined
    const animations = normalizeSettings(value).animations
    const ui = normalizeSettings(value).ui
    const models = normalizeModels(isRecord(value.models) ? value.models : undefined)
    const configured = normalizeConfigured(isRecord(value.configured) ? value.configured : undefined)
    const subagents = Array.isArray(value.subagents)
      ? (value.subagents as unknown[]).filter((entry): entry is string => typeof entry === "string" && validModelKey(entry)).slice(0, MODEL_AGENTS_MAX)
      : [...SUBAGENT_IDS]
    const maxParallel = normalizeMaxParallel(value.maxParallel)
    const routing = normalizeRouting(isRecord(value.routing) ? value.routing : undefined)
    return { animations, ui, models, configured, subagents, maxParallel, routing }
  } catch {
    return undefined
  }
}

export function mergeSettings(current: ChoreographerSettings, patch: unknown): ChoreographerSettings {
  const animations: Animations = { ...current.animations }
  const ui: Ui = { ...current.ui }
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
  let maxParallel = normalizeMaxParallel(current.maxParallel)
  if (!isRecord(patch)) return { animations, ui, models: { primary, fallback }, maxParallel }
  if (isRecord(patch.animations)) {
    if (typeof patch.animations.todo === "boolean") animations.todo = patch.animations.todo
    if (typeof patch.animations.running === "boolean") animations.running = patch.animations.running
  }
  if (isRecord(patch.ui)) {
    if (typeof patch.ui.todos === "boolean") ui.todos = patch.ui.todos
    if (typeof patch.ui.roster === "boolean") ui.roster = patch.ui.roster
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
  if (Object.prototype.hasOwnProperty.call(patch, "maxParallel")) {
    const entry = (patch as Record<string, unknown>).maxParallel
    if (entry === null) maxParallel = PARALLEL_DEFAULT
    else if (typeof entry === "number" && Number.isFinite(entry)) maxParallel = normalizeMaxParallel(entry)
  }
  return { animations, ui, models: { primary, fallback }, maxParallel }
}
