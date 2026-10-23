import { Plugin } from "@opencode/plugin"
import {
  AGENT_IDS,
  EXPLORE_ID,
  REVIEWER_IDS,
  STRICT_REVIEW_PROTOCOL,
  WORKER_IDS,
  buildDelegationText,
  buildReviewBrief,
  isReviewer,
  isWorker,
  normalizeOptions,
} from "./shared"
import { chooseModel, createBreaker, isQuotaError, parseModel, type ParsedModel } from "./fallback"

type Registration = { dispose: () => Promise<void> }

type ValidatedDiffInput = {
  mode: "working" | "branch" | "committed"
  base: string | undefined
  context: number
  path: string | undefined
}

function validateDiffInput(input: unknown): ValidatedDiffInput {
  const record = (input ?? {}) as Record<string, unknown>
  const rawMode = record.mode
  const mode = rawMode === "working" || rawMode === "branch" || rawMode === "committed" ? rawMode : "working"
  const rawContext = record.context
  const context =
    typeof rawContext === "number" && Number.isFinite(rawContext) ? Math.min(10, Math.max(0, Math.floor(rawContext))) : 3
  const rawBase = record.base
  const trimmedBase = typeof rawBase === "string" ? rawBase.trim() : ""
  if (trimmedBase && (/^[-]/.test(trimmedBase) || /[\s\x00-\x1F\x7F-\x9F]/.test(trimmedBase))) {
    throw new TypeError('diff: invalid "base": refs cannot start with "-" or contain whitespace')
  }
  const base = trimmedBase ? trimmedBase : undefined
  const rawPath = record.path
  const trimmedPath = typeof rawPath === "string" ? rawPath.trim() : ""
  const path = trimmedPath ? trimmedPath : undefined
  return { mode, base, context, path }
}

const MAX_DIFF_CHARS = 60_000

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
    .then(() => ctx.agent.list({}))
    .catch(() => undefined)
  const found = listed?.data.find((a) => a.id === agent)
  const model =
    found?.model !== undefined
      ? parseModel(found.model.providerID + "/" + found.model.id + (found.model.variant ? "#" + found.model.variant : ""))
      : undefined
  primaryCache.set(agent, { model, at: now })
  return model
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
    try {
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
              try {
                const result = await original(input, context)
                if (used !== undefined) breaker.succeed(used, startedAt)
                return result
              } catch (error) {
                // A cancelled child is not a provider failure; retrying would ignore the abort.
                if (context.signal.aborted) throw error
                const message = error instanceof Error ? error.message : String(error)
                if (/abort|cancel/i.test(message)) throw error
                if (agent === undefined) throw error
                const alternates = options.fallback[agent]
                if (used === undefined || alternates === undefined || alternates.length === 0) throw error
                if (!isQuotaError({ message }) && breaker.available(used)) throw error
                breaker.fail(used)
                const choice = chooseModel({ primary: used, alternates, available: (m) => breaker.available(m) })
                if (!choice.fellBack || choice.model === undefined) throw error
                // Never resend the model that just failed, and never route to an exhausted one.
                if (choice.model.key === used.key || !breaker.available(choice.model)) throw error
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

      const listed = await ctx.agent.list({}).catch(() => undefined)
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

      registrations.push(
        await ctx.tool.transform((editor) => {
          editor.add({
            name: "diff",
            description: "Read the current changes; mode working is uncommitted, branch is against the merge base, committed is the last commit; output is per-file with status and counts.",
            input: {
              type: "object",
              properties: {
                mode: { type: "string", enum: ["working", "branch", "committed"] },
                base: { type: "string" },
                context: { type: "integer", minimum: 0, maximum: 10 },
                path: { type: "string" },
              },
              additionalProperties: false,
            },
            options: { permission: "read" },
            execute: async (input) => {
              let mode: ValidatedDiffInput["mode"] = "working"
              try {
                const validated = validateDiffInput(input)
                mode = validated.mode
                const { base, context, path } = validated
                const { data } = await ctx.vcs.diff({ mode, base, context })
                const needle = path
                const scoped = needle ? data.filter((entry) => entry.file.includes(needle)) : data
                if (scoped.length === 0) {
                  if (needle && data.length > 0) {
                    return { content: `No files match path "${needle}". ${data.length} files changed in mode ${mode}.`, metadata: { files: 0, mode } }
                  }
                  return { content: base ? `No changes in mode ${mode} against ${base}.` : `No changes in mode ${mode}.`, metadata: { files: 0, mode } }
                }
                const blocks = scoped.map((entry) => {
                  const file = entry.file.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
                  const patch = entry.patch.replace(/\u001B\[[0-9;]*m/g, "").replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "")
                  return `${file} (${entry.status} +${entry.additions} -${entry.deletions})\n${patch}`
                })
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
                  return { content: text, metadata: { files: scoped.length, mode, truncated: true, total } }
                }
                return { content: text, metadata: { files: scoped.length, mode } }
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                return { content: `diff unavailable: ${message}`, metadata: { files: 0, mode, error: true } }
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
              const stored = session.metadata?.[TODOS_KEY]
              const prev = new Map<string, TodoStatus>()
              if (Array.isArray(stored)) {
                for (const entry of stored as unknown[]) {
                  if (
                    typeof entry === "object" &&
                    entry !== null &&
                    typeof (entry as { content?: unknown }).content === "string" &&
                    typeof (entry as { status?: unknown }).status === "string" &&
                    STATUSES.includes((entry as { status: string }).status as TodoStatus)
                  ) {
                    prev.set((entry as { content: string }).content, (entry as { status: string }).status as TodoStatus)
                  }
                }
              }
              // One step per write. Anything not already completed counts as newly completed, so marking everything in_progress in one write and completing it in the next cannot batch-complete a list.
              const newlyCompleted = parsed.filter(
                (item) => item.status === "completed" && prev.get(item.content) !== "completed",
              )
              if (newlyCompleted.length > 1) {
                throw new Error(
                  `Refused: ${newlyCompleted.length} items completed in one write. Complete at most one step per write: mark it in_progress, do the work, then mark it completed in the next write.`,
                )
              }
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
          console.log("[openchoreographer] registered todowrite and todoread")
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
- Write the list before the first tool call.
- Update it AT EVERY STEP TRANSITION: in one write, mark the finished step completed and the next step in_progress.
- Never batch updates to the end of the task; a list written once and reconciled at the end is not a ledger.
- If a new step appears mid-task, add it in that same write.
- One item per verifiable action, phrased as the action, not the goal.
- Never end a turn with an item still in_progress or pending unless blocked; say what blocks it.`,
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
            event.system.push({ type: "text", text: STRICT_REVIEW_PROTOCOL })
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
