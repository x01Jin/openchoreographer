export type ParsedModel = { readonly providerID: string; readonly modelID: string; readonly variant?: string; readonly key: string }

export function parseModel(value: unknown): ParsedModel | undefined {
  if (typeof value !== "string") return undefined
  if (value.length === 0) return undefined
  if (/\s/.test(value)) return undefined
  const hash = value.split("#")
  if (hash.length > 2) return undefined
  const base = hash[0]
  const variant = hash[1]
  if (variant !== undefined && variant.length === 0) return undefined
  if (base.startsWith("/") || base.endsWith("/")) return undefined
  const slash = base.indexOf("/")
  if (slash < 0) return undefined
  const providerID = base.slice(0, slash)
  const modelID = base.slice(slash + 1)
  if (providerID.length === 0 || modelID.length === 0) return undefined
  const key = providerID + "/" + modelID
  return variant === undefined ? { providerID, modelID, key } : { providerID, modelID, variant, key }
}

export type FailureKind = "quota" | "retryable" | "fatal"

export type FailureInput = {
  readonly type?: string
  readonly status?: number
  readonly message?: string
  readonly retryAfterMs?: number
} | undefined

const QUOTA_MESSAGE = /free usage limit|free usage exceeded|usage limit|usage exceeded|subscribe to opencode go|quota|insufficient (quota|credit|balance)|payment required|billing|out of credits|monthly limit|free tier|free plan/
const FATAL_TYPE = /invalid|bad[-_. ]?request|unsupported/i
const FATAL_MESSAGE = /not (currently )?supported|unsupported|invalid request/
const RETRYABLE_MESSAGE = /rate limit|too many requests|timed? ?out|timeout|econnreset|econnrefused|socket hang up|fetch failed|network|overloaded|temporarily unavailable/

export function classifyFailure(error: FailureInput): FailureKind {
  if (error === undefined || error === null) return "retryable"
  const message = typeof error.message === "string" ? error.message.toLowerCase().replace(/_/g, " ") : ""
  if (message.length > 0 && QUOTA_MESSAGE.test(message)) return "quota"
  if (error.status === 402) return "quota"
  if (typeof error.type === "string" && FATAL_TYPE.test(error.type)) return "fatal"
  if (message.length > 0 && FATAL_MESSAGE.test(message)) return "fatal"
  if (typeof error.status === "number" && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) return "fatal"
  if (typeof error.status === "number" && (error.status === 408 || error.status === 429 || error.status >= 500)) return "retryable"
  if (message.length > 0 && RETRYABLE_MESSAGE.test(message)) return "retryable"
  return "retryable"
}

export type RetryPlan =
  | { readonly kind: "retry"; readonly delayMs: number; readonly degrade: boolean }
  | { readonly kind: "fallback"; readonly mark: "quota" | "retries" }
  | { readonly kind: "surface" }

export function planRetryDecision(input: {
  readonly error: FailureInput
  readonly attempt: number
  readonly degraded: boolean
  readonly hasFallback: boolean
}): RetryPlan {
  if (!input.hasFallback) return { kind: "surface" }
  const kind = classifyFailure(input.error)
  if (kind === "quota") return { kind: "fallback", mark: "quota" }
  if (kind === "fatal") return { kind: "surface" }
  if (input.degraded) return { kind: "fallback", mark: "retries" }
  if (input.attempt >= 3) return { kind: "fallback", mark: "retries" }
  const hint = input.error !== undefined && input.error !== null ? input.error.retryAfterMs : undefined
  const base = typeof hint === "number" && Number.isFinite(hint) ? hint : 1000 * input.attempt
  return { kind: "retry", delayMs: Math.min(Math.max(base, 0), 15000), degrade: true }
}

export const FALLBACK_WINDOW_MS = 300_000

export type HealthReason = "quota" | "retries"

type ModelHealthOptions = { readonly windowMs: number; readonly now?: () => number; readonly onChange?: () => void }

export type ModelHealth = {
  down(model: ParsedModel): boolean
  waitMs(model: ParsedModel): number
  reason(model: ParsedModel): HealthReason | undefined
  degraded(model: ParsedModel): boolean
  fail(model: ParsedModel, reason: HealthReason): void
  degrade(model: ParsedModel): void
  succeed(model: ParsedModel, since?: number): void
  reset(models: readonly ParsedModel[]): void
  snapshot(): ReadonlyArray<{ model: string; reason: HealthReason; waitMs: number; degraded: boolean }>
}

type HealthEntry = { until: number; reason?: HealthReason; degradedSince?: number }

export function createModelHealth(options: ModelHealthOptions): ModelHealth {
  const windowMs = options.windowMs
  const clock = options.now ?? Date.now
  const onChange = options.onChange
  const entries = new Map<string, HealthEntry>()
  const notify = () => {
    if (onChange !== undefined) onChange()
  }
  return {
    down(model) {
      const entry = entries.get(model.key)
      return entry !== undefined && clock() < entry.until
    },
    waitMs(model) {
      const entry = entries.get(model.key)
      if (entry === undefined) return 0
      return Math.max(0, entry.until - clock())
    },
    reason(model) {
      const entry = entries.get(model.key)
      if (entry === undefined || clock() >= entry.until) return undefined
      return entry.reason ?? "retries"
    },
    degraded(model) {
      return entries.get(model.key)?.degradedSince !== undefined
    },
    fail(model, reason) {
      entries.set(model.key, { until: clock() + windowMs, reason })
      notify()
    },
    degrade(model) {
      const entry = entries.get(model.key)
      if (entry === undefined) entries.set(model.key, { until: 0, degradedSince: clock() })
      else entry.degradedSince = clock()
      notify()
    },
    succeed(model, since) {
      const entry = entries.get(model.key)
      if (entry === undefined || entry.degradedSince === undefined) return
      if (since !== undefined && entry.degradedSince > since) return
      entry.degradedSince = undefined
      notify()
    },
    reset(models) {
      let removed = false
      for (const model of models) {
        if (entries.delete(model.key)) removed = true
      }
      if (removed) notify()
    },
    snapshot() {
      const at = clock()
      const rows: { model: string; reason: HealthReason; waitMs: number; degraded: boolean }[] = []
      for (const [model, entry] of entries) {
        if (entry.until <= at) continue
        rows.push({ model, reason: entry.reason ?? "retries", waitMs: entry.until - at, degraded: entry.degradedSince !== undefined })
      }
      return rows
    },
  }
}

type Selection = { readonly model: ParsedModel | undefined; readonly primary: ParsedModel | undefined; readonly fellBack: boolean }

export function resultText(value: unknown): string {
  if (typeof value !== "object" || value === null) return ""
  const content = (value as { content?: unknown }).content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    let text = ""
    for (const entry of content) {
      if (typeof entry !== "object" || entry === null) continue
      const record = entry as { type?: unknown; text?: unknown }
      if (record.type === "text" && typeof record.text === "string") text += record.text
    }
    return text
  }
  return ""
}

export function isChildFailure(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false
  const metadata = (value as { metadata?: unknown }).metadata
  if (typeof metadata === "object" && metadata !== null) {
    const state = (metadata as { state?: unknown }).state
    if (state === "error" || state === "failed") return true
    if (state !== undefined) return false
  }
  return resultText(value).includes('state="error"') || resultText(value).includes('state="failed"')
}

export function isChildQuotaFailure(value: unknown): boolean {
  if (!isChildFailure(value)) return false
  return classifyFailure({ message: resultText(value) }) === "quota"
}

export function planRetriedResult(input: { readonly result: unknown; readonly alternate: ParsedModel }): {
  readonly credit?: ParsedModel
  readonly fail?: ParsedModel
} {
  if (isChildQuotaFailure(input.result)) return { fail: input.alternate }
  return { credit: input.alternate }
}

export function chooseModel(input: {
  readonly primary: ParsedModel | undefined
  readonly alternates: readonly ParsedModel[]
  readonly available: (model: ParsedModel) => boolean
}): Selection {
  if (input.primary === undefined) return { model: undefined, primary: undefined, fellBack: false }
  if (input.available(input.primary)) return { model: input.primary, primary: input.primary, fellBack: false }
  for (const alternate of input.alternates) {
    if (input.available(alternate)) return { model: alternate, primary: input.primary, fellBack: true }
  }
  if (input.alternates.length === 0) return { model: input.primary, primary: input.primary, fellBack: false }
  // Every alternate is also exhausted; still try the last one rather than failing outright.
  const last = input.alternates[input.alternates.length - 1]
  return { model: last, primary: input.primary, fellBack: true }
}
