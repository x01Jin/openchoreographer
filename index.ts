import { lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin"
import {
  AGENT_IDS,
  EXPLORE_ID,
  MAX_DIFF_CHARS,
  REVIEWER_IDS,
  STEP_DEFAULTS,
  WORKER_IDS,
  buildDelegationText,
  buildReviewBrief,
  clipResultStats,
  collapseEolOnlyChanges,
  isReviewer,
  isWorker,
  normalizeOptions,
  sanitizeForContext,
  summarizeChanges,
  validateDiffInput,
  type Options,
  type ValidatedDiffInput,
} from "./shared"
import { chooseModel, createBreaker, isChildQuotaFailure, isQuotaError, parseModel, planResultFallback, planRetriedResult, type ParsedModel } from "./fallback"
import { ChoreographerRpc } from "./rpc"
import { SETTINGS_KEY, clampSteps, defaultSettings, mergeSettings, normalizeSettings, type SettingsSnapshot } from "./settings"

type Registration = { dispose: () => Promise<void> }

let active: Registration[] = []
let epoch = 0
const breaker = createBreaker({ initialMs: 5 * 60_000, maxMs: 60 * 60_000 })
let wrapperInstalled = false

const PRIMARY_TTL_MS = 30_000
const primaryCache = new Map<string, { model: ParsedModel | undefined; at: number }>()

async function resolvePrimary(ctx: Plugin.Context, agent: string): Promise<ParsedModel | undefined> {
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

type TreeEntry = { readonly file: string; readonly status: string }

function treeKey(entry: TreeEntry): string {
  return entry.file + ":" + entry.status
}

const TREE_CACHE_MS = 1000
const treeCache = new Map<string, { at: number; promise: Promise<readonly TreeEntry[] | undefined> }>()

// The baseline read is shared per location for 1000 ms so parallel spawns reuse one in-flight or settled VCS call,
// failures included. Trade-off: a change made within the window before a spawn is treated as pre-existing
// by the retry gate.
async function readTree(ctx: Plugin.Context, fresh = false): Promise<readonly TreeEntry[] | undefined> {
  const now = Date.now()
  for (const [key, entry] of treeCache) {
    if (now - entry.at >= TREE_CACHE_MS) treeCache.delete(key)
  }
  const dir = ctx.location.directory
  if (!fresh) {
    const cached = treeCache.get(dir)
    if (cached !== undefined) return cached.promise
  }
  const pending = (async (): Promise<readonly TreeEntry[] | undefined> => {
    try {
      const { data } = await ctx.vcs.status()
      return data
    } catch {
      return undefined
    }
  })()
  treeCache.set(dir, { at: now, promise: pending })
  return pending
}

function changedFiles(baseline: ReadonlySet<string>, current: readonly TreeEntry[]): string[] {
  const changed: string[] = []
  for (const entry of current) {
    if (baseline.has(treeKey(entry))) continue
    if (!changed.includes(entry.file)) changed.push(entry.file)
  }
  return changed
}

function changedTreeError(error: unknown, changed: readonly string[]): Error {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/\u001B\[[0-9;]*m/g, "")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "")
  const named =
    changed.slice(0, 5).map(sanitizeForContext).join(", ") + (changed.length > 5 ? ` +${changed.length - 5} more` : "")
  return new Error(
    `${message}\nNot retrying on a fallback model: the working tree changed after this spawn started, so a retry would run against files that may already hold its work (${named}). Verify the diff instead of spawning it again.`,
    { cause: error },
  )
}

async function warnNarrowFallbacks(ctx: Plugin.Context, options: Options): Promise<void> {
  try {
    const catalog = await ctx.model.list()
    const limits = new Map<string, number>()
    for (const model of catalog.data) {
      // The catalog carries the model id twice; index both so either form resolves a configured key.
      limits.set(model.providerID + "/" + model.modelID, model.limit.context)
      limits.set(model.providerID + "/" + model.id, model.limit.context)
    }
    for (const [agent, alternates] of Object.entries(options.fallback)) {
      if (alternates.length === 0) continue
      const primary = await resolvePrimary(ctx, agent)
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

const TODOS_KEY = "openchoreographer.todos"

const STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const
type TodoStatus = (typeof STATUSES)[number]

const PRIORITIES = ["high", "medium", "low"] as const
type TodoPriority = (typeof PRIORITIES)[number]

type TodoItem = { id: string; content: string; status: TodoStatus; priority?: TodoPriority }

type TodoCounts = { total: number; completed: number; in_progress: number; pending: number; cancelled: number }

const TODO_ITEM_INPUT = {
  type: "object",
  properties: {
    id: { type: "string", description: "Stable identifier; generated when omitted" },
    content: { type: "string", description: "One verifiable action" },
    status: { type: "string", enum: [...STATUSES] },
    priority: { type: "string", enum: [...PRIORITIES] },
  },
  required: ["content", "status"],
  additionalProperties: false,
}

const TODOWRITE_INPUT = {
  type: "object",
  properties: { todos: { type: "array", items: TODO_ITEM_INPUT } },
  required: ["todos"],
  additionalProperties: false,
}

const TODOREAD_INPUT = {
  type: "object",
  properties: {},
  additionalProperties: false,
}

let todoSeq = 0

function parseTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) throw new Error("todowrite: \"todos\" must be an array")
  if (raw.length > 200) throw new Error(`todowrite: too many todos (${raw.length}); the limit is 200`)
  return raw.map((entry, index): TodoItem => {
    if (typeof entry !== "object" || entry === null) throw new Error(`todowrite: item ${index} must be an object`)
    const item = entry as Record<string, unknown>
    if (typeof item.content !== "string" || !item.content.trim()) throw new Error(`todowrite: item ${index} needs a non-empty "content"`)
    if (item.content.length > 500) throw new Error(`todowrite: item ${index} "content" is too long (${item.content.length} chars); the limit is 500`)
    if (typeof item.status !== "string" || !STATUSES.includes(item.status as TodoStatus)) throw new Error(`todowrite: item ${index} has invalid "status": ${JSON.stringify(item.status)}`)
    if (item.priority !== undefined && (typeof item.priority !== "string" || !PRIORITIES.includes(item.priority as TodoPriority))) throw new Error(`todowrite: item ${index} has invalid "priority": ${JSON.stringify(item.priority)}`)
    if (item.id !== undefined && (typeof item.id !== "string" || !item.id || item.id.length > 64)) throw new Error(`todowrite: item ${index} has invalid "id"`)
    return {
      id: typeof item.id === "string" ? item.id : `todo-${todoSeq++}`,
      content: item.content,
      status: item.status as TodoStatus,
      ...(item.priority !== undefined ? { priority: item.priority as TodoPriority } : {}),
    }
  })
}

function countTodos(list: TodoItem[]): TodoCounts {
  const counts: TodoCounts = { total: list.length, completed: 0, in_progress: 0, pending: 0, cancelled: 0 }
  for (const item of list) counts[item.status] += 1
  return counts
}

export function agentDirs(location: { directory: string }): string[] {
  const candidates = [
    join(location.directory, ".opencode", "agents"),
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode", "agents"),
  ]
  return [...new Set(candidates)]
}

const MAX_AGENT_FILE_BYTES = 1_000_000

function agentFilePath(dirs: readonly string[], id: string): string | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) return undefined
  for (const dir of dirs) {
    const path = join(dir, `${id}.md`)
    try {
      if (!lstatSync(path).isFile()) continue
      const real = realpathSync(path)
      const root = realpathSync(dir)
      if (real.toLowerCase() !== join(root, `${id}.md`).toLowerCase()) continue
      if (statSync(path).size > MAX_AGENT_FILE_BYTES) continue
      return path
    } catch {
      continue
    }
  }
  return undefined
}

export function readAgentSteps(dirs: readonly string[], id: string): number | null {
  const path = agentFilePath(dirs, id)
  if (path === undefined) return null
  let content: string
  try {
    content = readFileSync(path, "utf8")
  } catch {
    return null
  }
  const match = content.match(/^steps:[ \t]*["']?(-?\d+)/m)
  if (!match) return null
  const n = Number(match[1])
  if (!Number.isFinite(n)) return null
  return clampSteps(n)
}

export function writeAgentSteps(dirs: readonly string[], id: string, value: number): void {
  const path = agentFilePath(dirs, id)
  if (path === undefined) throw new Error("openchoreographer: agent file not found or unsafe")
  const content = readFileSync(path, "utf8")
  const line = `steps: ${value}`
  const existing = /^steps:[^\n]*$/m
  if (existing.test(content)) {
    const next = content.replace(existing, line)
    if (next !== content) writeFileSync(path, next, "utf8")
    return
  }
  if (!/^---[ \t]*\r?$/m.test(content)) throw new Error("openchoreographer: agent frontmatter not found")
  const next = content.replace(/^(---[ \t]*)(\r?\n)/m, (_, prefix, eol) => `${prefix}${eol}${line}${eol}`)
  if (next !== content) writeFileSync(path, next, "utf8")
}

export default Plugin.define({
  id: "openchoreographer",
  async setup(ctx) {
    const generation = ++epoch
    wrapperInstalled = false
    const previous = active
    active = []
    await Promise.allSettled(previous.map((registration) => registration.dispose()))
    const options = normalizeOptions(ctx.options)
    const registrations: Registration[] = []
    const managedIds = [...new Set([options.agent, ...AGENT_IDS])].filter((id) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id))
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
      const dirs = agentDirs(ctx.location)
      let fileSteps: Record<string, number> = {}
      for (const id of managedIds) {
        const value = readAgentSteps(dirs, id)
        if (value !== null) fileSteps[id] = value
      }
      const snapshot = (): SettingsSnapshot => ({ animations: settings.current.animations, ui: settings.current.ui, steps: { ...fileSteps }, defaults: Object.fromEntries(managedIds.map((id) => [id, STEP_DEFAULTS[id] ?? null])), managed: managedIds })
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
          settings.current = mergeSettings(settings.current, input, managedIds)
          settings.current.steps = {}
          const patch = (typeof input === "object" && input !== null ? input : undefined) as { steps?: unknown } | undefined
          if (patch !== undefined && patch.steps !== null && typeof patch.steps === "object" && !Array.isArray(patch.steps)) {
            const stepsPatch = patch.steps as Record<string, unknown>
            const targets: { id: string; path: string; value: number }[] = []
            for (const id of managedIds) {
              const raw = stepsPatch[id]
              const value =
                raw === null ? STEP_DEFAULTS[id] : typeof raw === "number" ? clampSteps(raw) : undefined
              if (value === undefined) continue
              const path = agentFilePath(dirs, id)
              if (path === undefined) throw new Error("openchoreographer: agent file not found or unsafe")
              targets.push({ id, path, value })
            }
            for (const target of targets) {
              writeAgentSteps(dirs, target.id, target.value)
              fileSteps[target.id] = target.value
            }
            scheduleReload()
          }
          await ctx.storage.set(SETTINGS_KEY, settings.current)
          const snap = snapshot()
          if (emitUpdated) await emitUpdated(snap)
          return snap
        },
      })
      registrations.push(rpc)
      emitUpdated = (snap) => rpc.events.emit("updated", snap)
      registrations.push(
        await ctx.session.hook("retry", (event) => {
          if (!isQuotaError(event.error)) return
          // The host Model.Ref splits provider and id, so rejoin them for breaker accounting.
          const current = parseModel(event.model.providerID + "/" + event.model.id + (event.model.variant ? "#" + event.model.variant : ""))
          if (current === undefined) return
          breaker.fail(current, { retryAfterMs: event.error.retryAfterMs })
          const alternates = options.fallback[event.agent]
          // Only suppress the host retry when the wrapper can actually route to a fallback.
          if (alternates !== undefined && alternates.length > 0 && wrapperInstalled) event.decision = { retry: false }
        }),
      )

      registrations.push(
        await ctx.tool.hook("execute.before", async (event) => {
          if (event.tool !== "subagent") return
          if (typeof event.input !== "object" || event.input === null) return
          // The subagent input shape is host-defined, so narrow it once to read fields.
          const record = event.input as Record<string, unknown>
          if (typeof record.agent !== "string") return
          const agent = record.agent
          const alternates = options.fallback[agent]
          if (alternates === undefined || alternates.length === 0) return
          const configured = await resolvePrimary(ctx, agent)
          if (configured === undefined) return
          let primary = configured
          const raw = record.model
          if (typeof raw === "string") {
            const requested = parseModel(raw)
            if (requested !== undefined) {
              if (breaker.available(requested)) return
              primary = requested
            }
          }
          const choice = chooseModel({ primary, alternates, available: (m) => breaker.available(m) })
          if (choice.model !== undefined && choice.fellBack) {
            record.model = choice.model.key + (choice.model.variant ? "#" + choice.model.variant : "")
          }
        }),
      )

      registrations.push(
        await ctx.tool.hook("execute.after", (event) => {
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
        }),
      )

      registrations.push(
        await ctx.tool.transform((editor) => {
          const target = editor.get("subagent")
          if (target === undefined || typeof target.execute !== "function") return
          editor.update("subagent", (tool) => {
            const original = target.execute
            tool.execute = async (input, context) => {
              // The subagent input shape is host-defined, so narrow it once to read fields.
              const fields = input as Record<string, unknown>
              const startedAt = Date.now()
              const agent = typeof fields.agent === "string" ? fields.agent : undefined
              const used =
                typeof fields.model === "string"
                  ? parseModel(fields.model)
                  : agent === undefined
                    ? undefined
                    : await resolvePrimary(ctx, agent)
              let baseline: ReadonlySet<string> | undefined
              try {
                // The baseline is status-based: a file already dirty at spawn and edited further is not detected.
                if (agent !== undefined && options.fallback[agent]?.length) {
                  const tree = await readTree(ctx)
                  if (tree !== undefined) baseline = new Set(tree.map(treeKey))
                }
                const result = await original(input, context)
                const actual = typeof fields.model === "string" ? parseModel(fields.model) : used
                const plan = planResultFallback({
                  result,
                  actual,
                  alternates: agent !== undefined ? (options.fallback[agent] ?? []) : [],
                  available: (m) => breaker.available(m),
                  aborted: context.signal.aborted,
                })
                if (plan.kind === "return") {
                  if (plan.credit !== undefined) breaker.succeed(plan.credit, startedAt)
                  else if (actual !== undefined && isChildQuotaFailure(result)) breaker.fail(actual)
                  return result
                }
                if (agent !== undefined) {
                  const alternates = options.fallback[agent] ?? []
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
                    const next = alternate.key + (alternate.variant ? "#" + alternate.variant : "")
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
                const alternates = options.fallback[agent] ?? []
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
                const alternate = choice.model.key + (choice.model.variant ? "#" + choice.model.variant : "")
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
        }),
      )

      const listed = await ctx.agent.list({ location: ctx.location }).catch(() => undefined)
      if (listed) {
        const ids = listed.data.map((agent) => agent.id)
        const missing = ids.length > 0 ? AGENT_IDS.filter((id) => !ids.includes(id)) : []
        if (missing.length > 0) {
          console.warn("openchoreographer: agent definitions not registered: " + missing.join(", ") + ". Run: node bin/install.mjs --force, then restart OpenCode.")
        }
        for (const id of Object.keys(options.fallback)) {
          const found = listed.data.find((a) => a.id === id)
          if (found?.model === undefined) {
            console.warn(`openchoreographer: fallback configured for "${id}" but that agent has no explicit model; it inherits the parent and fallback is skipped`)
          }
        }
      } else {
        console.warn("openchoreographer: agent list unavailable, skipping setup validation")
      }

      // Context-window limits are advisory; a catalog read must never break setup.
      if (Object.keys(options.fallback).length > 0) void warnNarrowFallbacks(ctx, options).catch(() => undefined)

      registrations.push(
        await ctx.tool.transform((editor) => {
          editor.add({
            name: "diff",
            description: "Read the current changes; mode working is uncommitted, branch is against the merge base, committed is the last commit; output is per-file with status and counts, or pass stat: true for counts-only lines without patches.",
            input: {
              type: "object",
              properties: {
                mode: { type: "string", enum: ["working", "branch", "committed"] },
                base: { type: "string" },
                context: { type: "integer", minimum: 0, maximum: 10 },
                path: { type: "string" },
                stat: { type: "boolean" },
              },
              additionalProperties: false,
            },
            options: { permission: "read" },
            execute: async (input) => {
              let mode: ValidatedDiffInput["mode"] = "working"
              let stat = false
              try {
                const validated = validateDiffInput(input)
                mode = validated.mode
                stat = validated.stat
                const { base, context, path } = validated
                const { data } = await ctx.vcs.diff({ mode, base, context })
                const needle = path
                const scoped = needle ? data.filter((entry) => entry.file.includes(needle)) : data
                if (scoped.length === 0) {
                  if (needle && data.length > 0) {
                    return { content: `No files match path "${needle}". ${data.length} files changed in mode ${mode}.`, metadata: { files: 0, mode, ...(stat ? { stat: true as const } : {}) } }
                  }
                  return { content: base ? `No changes in mode ${mode} against ${base}.` : `No changes in mode ${mode}.`, metadata: { files: 0, mode, ...(stat ? { stat: true as const } : {}) } }
                }
                // A CRLF working tree over LF blobs turns every modified file into a whole-file rewrite; collapse those
                // pairs first so the summary, the counts, and the 60k budget all describe what actually changed.
                const changed = scoped.flatMap((entry) => {
                  const collapsed = collapseEolOnlyChanges(entry.patch)
                  return collapsed === undefined ? [] : [{ entry, collapsed }]
                })
                if (changed.length === 0) {
                  return { content: base ? `No changes in mode ${mode} against ${base}.` : `No changes in mode ${mode}.`, metadata: { files: 0, mode, ...(stat ? { stat: true as const } : {}) } }
                }
                const header = summarizeChanges(
                  changed.map(({ entry, collapsed }) => ({
                    file: entry.file,
                    patch: collapsed.patch,
                    additions: collapsed.additions,
                    deletions: collapsed.deletions,
                  })),
                )
                const blocks = stat
                  ? [
                      header,
                      ...changed.map(({ entry, collapsed }) => {
                        const file = entry.file.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
                        return `${entry.status} ${file} +${collapsed.additions} -${collapsed.deletions}`
                      }),
                    ]
                  : [
                      header,
                      ...changed.map(({ entry, collapsed }) => {
                      const file = entry.file.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
                      const patch = collapsed.patch.replace(/\u001B\[[0-9;]*m/g, "").replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "")
                      return `${file} (${entry.status} +${collapsed.additions} -${collapsed.deletions})\n${patch}`
                      }),
                    ]
                const total = blocks.reduce((sum, block) => sum + block.length, 0) + (blocks.length > 1 ? (blocks.length - 1) * 2 : 0)
                const kept: string[] = []
                let keptLength = 0
                for (const block of blocks) {
                  kept.push(block)
                  keptLength += block.length + (kept.length > 1 ? 2 : 0)
                  if (keptLength > MAX_DIFF_CHARS) break
                }
                let text = kept.join("\n\n")
                if (text.length > MAX_DIFF_CHARS) {
                  let cut = text.lastIndexOf("\n", MAX_DIFF_CHARS)
                  if (cut < 0) cut = MAX_DIFF_CHARS
                  if (cut > 0 && cut < text.length) {
                    const low = text.charCodeAt(cut - 1)
                    if (low >= 0xd800 && low <= 0xdbff) cut -= 1
                  }
                  const shown = cut
                  text = text.slice(0, cut) + `\n… truncated at 60000 chars (showing ${shown} of ${total}); pass path to narrow, or base to compare against another ref`
                  return { content: text, metadata: { files: changed.length, mode, truncated: true, total, ...(stat ? { stat: true as const } : {}) } }
                }
                return { content: text, metadata: { files: changed.length, mode, ...(stat ? { stat: true as const } : {}) } }
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                return { content: `diff unavailable: ${message}`, metadata: { files: 0, mode, error: true, ...(stat ? { stat: true as const } : {}) } }
              }
            },
          })
        }),
      )

      registrations.push(
        await ctx.tool.transform((editor) => {
          editor.add({
            name: "todowrite",
            description: "Replace this session's todo list and return per-status counts.",
            input: TODOWRITE_INPUT,
            execute: async (input, { sessionID }) => {
              const parsed = parseTodos((input as { todos?: unknown } | undefined)?.todos)
              const session = await ctx.session.get({ sessionID })
              const rows: Array<Record<string, string>> = parsed.map((item) => {
                const row: Record<string, string> = { id: item.id, content: item.content, status: item.status }
                if (item.priority) row.priority = item.priority
                return row
              })
              await ctx.session.update({ sessionID, metadata: { ...(session.metadata ?? {}), [TODOS_KEY]: rows } })
              return { content: JSON.stringify(countTodos(parsed)) }
            },
          })
          editor.add({
            name: "todoread",
            description: "Return this session's todo list as JSON; empty list when unset.",
            input: TODOREAD_INPUT,
            execute: async (_input, { sessionID }) => {
              const session = await ctx.session.get({ sessionID })
              const stored = session.metadata?.[TODOS_KEY]
              const rows = Array.isArray(stored)
                ? (stored as unknown[]).filter((entry) => typeof entry === "object" && entry !== null && typeof (entry as { content?: unknown }).content === "string")
                : []
              return { content: JSON.stringify(rows) }
            },
          })
        }),
      )

      registrations.push(
        await ctx.tool.transform((editor) => {
          editor.add({
            name: "fallback_status",
            description: "Report each managed agent's primary model, configured fallbacks, and any active rate-limit backoff.",
            input: { type: "object", properties: {}, additionalProperties: false },
            options: { permission: "read" },
            execute: async () => {
              try {
                const managed: readonly string[] = [EXPLORE_ID, ...WORKER_IDS, ...REVIEWER_IDS]
                const agents = await Promise.all(
                  managed.map(async (agent) => {
                    const primary = await resolvePrimary(ctx, agent)
                    const fallbacks = options.fallback[agent] ?? []
                    const models = primary === undefined ? fallbacks : [primary, ...fallbacks]
                    return {
                      agent,
                      primary: primary === undefined ? null : primary.key,
                      fallbacks: fallbacks.map((model) => model.key),
                      backoffMs: models
                        .map((model) => ({ model: model.key, waitMs: breaker.waitMs(model) }))
                        .filter((entry) => entry.waitMs > 0),
                    }
                  }),
                )
                return { content: JSON.stringify({ agents }, null, 2) }
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                return { content: "fallback status unavailable: " + message }
              }
            },
          })
        }),
      )

      registrations.push(
        await ctx.command.transform((editor) => {
          editor.add({
            name: "orchestrate",
            description: "Switch to the orchestrator and start a delegated task",
            execute: async ({ sessionID, prompt, delivery }) => {
              await ctx.session.switchAgent({ sessionID, agent: options.agent })
              await ctx.session.prompt({
                ...prompt,
                sessionID,
                text: prompt.text?.trim() || "What should I orchestrate?",
                delivery,
              })
            },
          })
          editor.add({
            name: "review-panel",
            description: "Run a strict review panel on the current changes",
            execute: async ({ sessionID, prompt, delivery }) => {
              await ctx.session.switchAgent({ sessionID, agent: options.agent })
              const brief = buildReviewBrief(options)
              const request = prompt.text?.trim()
              await ctx.session.prompt({
                ...prompt,
                sessionID,
                text: request ? `${brief}\n\nUser request: ${request}` : brief,
                delivery,
              })
            },
          })
        }),
      )

      registrations.push(
        await ctx.session.hook("context", (event) => {
          if (event.agent === options.agent) {
            event.system.push({
              type: "text",
              text: `TODO discipline:
- Write the list before the first tool call; each item is one verifiable action phrased as the action.
- At each step transition, in one write mark the finished item completed and the next in_progress, adding a mid-task step there too; never batch completions to the end.
- Never end a turn with an item pending or in_progress unless blocked, and say what blocks it.`,
            })
            delete event.tools.edit
            delete event.tools.write
            delete event.tools.patch
            delete event.tools.shell
            event.system.push({ type: "text", text: buildDelegationText(options) })
            return
          }
          if (isReviewer(event.agent)) {
            delete event.tools.edit
            delete event.tools.write
            delete event.tools.patch
            delete event.tools.shell
            delete event.tools.subagent
            delete event.tools.question
            return
          }
          if (isWorker(event.agent)) {
            delete event.tools.subagent
            delete event.tools.question
            delete event.tools.diff
          } else {
            delete event.tools.diff
          }
        }),
      )

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
