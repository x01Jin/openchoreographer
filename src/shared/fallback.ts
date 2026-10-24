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

const QUOTA_PHRASES: readonly string[] = [
  "rate limit",
  "ratelimit",
  "too many requests",
  "quota exceeded",
  "quota limit",
  "insufficient quota",
  "insufficient credit",
  "insufficient balance",
  "usage limit",
  "monthly limit",
  "free tier",
  "free plan",
]

export function isQuotaError(error: { status?: number; message?: string }): boolean {
  if (error === undefined || error === null) return false
  if (error.status === 429 || error.status === 402) return true
  // A concrete status that is not a quota status is authoritative; its message must not override it.
  if (typeof error.status === "number") return false
  if (typeof error.message !== "string") return false
  // Provider error codes use underscores ("insufficient_quota"), prose uses spaces.
  const text = error.message.toLowerCase().replace(/_/g, " ")
  return QUOTA_PHRASES.some((phrase) => text.includes(phrase))
}

type BreakerOptions = { readonly initialMs: number; readonly maxMs: number; readonly now?: () => number }

export type Breaker = {
  fail(model: ParsedModel, options?: { retryAfterMs?: number }): number
  succeed(model: ParsedModel, since?: number): void
  available(model: ParsedModel): boolean
  waitMs(model: ParsedModel): number
  snapshot(): ReadonlyArray<{ model: string; waitMs: number }>
}

type Entry = { until: number; backoff: number; since: number }

export function createBreaker(options: BreakerOptions): Breaker {
  const initialMs = options.initialMs
  const maxMs = options.maxMs
  const clock = options.now ?? Date.now
  const entries = new Map<string, Entry>()
  return {
    fail(model, retry) {
      const at = clock()
      const hint = retry?.retryAfterMs
      const retryAfterMs = Number.isFinite(hint) && (hint as number) > 0 ? (hint as number) : undefined
      const current = entries.get(model.key)
      if (current !== undefined && at < current.until) {
        const wait = Math.min(Math.max(retryAfterMs ?? current.backoff, current.backoff), maxMs)
        const candidate = at + wait
        if (candidate > current.until) current.until = candidate
        // The latest failure re-opens the window, so only successes started after it may clear the entry.
        current.since = at
        return wait
      }
      const backoff = current === undefined ? initialMs : Math.min(current.backoff * 2, maxMs)
      const wait = Math.min(Math.max(retryAfterMs ?? backoff, backoff), maxMs)
      entries.set(model.key, { until: at + wait, backoff, since: at })
      return wait
    },
    succeed(model, since) {
      const current = entries.get(model.key)
      if (current === undefined) return
      if (since !== undefined && current.since > since) return
      entries.delete(model.key)
    },
    available(model) {
      const current = entries.get(model.key)
      return current === undefined || clock() >= current.until
    },
    waitMs(model) {
      const current = entries.get(model.key)
      if (current === undefined) return 0
      return Math.max(0, current.until - clock())
    },
    snapshot() {
      const at = clock()
      return [...entries]
        .filter(([, entry]) => entry.until > at)
        .map(([model, entry]) => ({ model, waitMs: entry.until - at }))
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

export function isChildQuotaFailure(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false
  const text = resultText(value)
  if (!isQuotaError({ message: text })) return false
  const metadata = (value as { metadata?: unknown }).metadata
  if (typeof metadata === "object" && metadata !== null) {
    const state = (metadata as { state?: unknown }).state
    if (state === "error" || state === "failed") return true
    if (state !== undefined) return false
  }
  return text.includes('state="error"') || text.includes('state="failed"')
}

type ResultPlan =
  | { readonly kind: "return"; readonly credit?: ParsedModel }
  | { readonly kind: "retry"; readonly fail?: ParsedModel; readonly model: ParsedModel }

export function planResultFallback(input: {
  readonly result: unknown
  readonly actual: ParsedModel | undefined
  readonly alternates: readonly ParsedModel[]
  readonly available: (model: ParsedModel) => boolean
  readonly aborted: boolean
}): ResultPlan {
  if (input.aborted) return { kind: "return" }
  if (!isChildQuotaFailure(input.result)) {
    return input.actual === undefined ? { kind: "return" } : { kind: "return", credit: input.actual }
  }
  const candidates =
    input.actual === undefined ? [...input.alternates] : input.alternates.filter((m) => m.key !== input.actual?.key)
  if (candidates.length === 0) return { kind: "return" }
  const chosen = candidates.find((m) => input.available(m)) ?? candidates[candidates.length - 1]
  return input.actual === undefined ? { kind: "retry", model: chosen } : { kind: "retry", fail: input.actual, model: chosen }
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
