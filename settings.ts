export type Animations = { todo: boolean; running: boolean }
export type Ui = { todos: boolean; roster: boolean }
export type ChoreographerSettings = { animations: Animations; ui: Ui; steps: Record<string, number> }
export type SettingsSnapshot = {
  animations: Animations
  ui: Ui
  steps: Record<string, number>
  defaults: Record<string, number | null>
  managed: string[]
}
export const STEPS_MIN = 1
export const STEPS_MAX = 2000
export const STEPS_STEP = 5
export const SETTINGS_KEY = "settings"

export function defaultSettings(): ChoreographerSettings {
  return { animations: { todo: true, running: true }, ui: { todos: true, roster: true }, steps: {} }
}

export function clampSteps(value: number): number {
  if (!Number.isFinite(value)) return STEPS_MIN
  return Math.min(STEPS_MAX, Math.max(STEPS_MIN, Math.round(value)))
}

// Assignment to one of these keys would mutate the prototype chain instead of the record.
const BLOCKED_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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
  return { animations, ui, steps }
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
    return { animations, ui, steps, defaults, managed }
  } catch {
    return undefined
  }
}

export function sameSteps(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false
    if (b[key] !== a[key]) return false
  }
  return true
}

export function mergeSettings(
  current: ChoreographerSettings,
  patch: unknown,
  managed: readonly string[],
): ChoreographerSettings {
  const animations: Animations = { ...current.animations }
  const ui: Ui = { ...current.ui }
  const steps: Record<string, number> = { ...current.steps }
  if (!isRecord(patch)) return { animations, ui, steps }
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
  return { animations, ui, steps }
}
