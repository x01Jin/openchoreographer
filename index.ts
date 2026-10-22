import { Plugin } from "@opencode/plugin"
import {
  AGENT_IDS,
  STRICT_REVIEW_PROTOCOL,
  buildDelegationText,
  buildReviewBrief,
  isReviewer,
  isWorker,
  normalizeOptions,
} from "./shared"

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
    const previous = active
    active = []
    await Promise.allSettled(previous.map((registration) => registration.dispose()))
    const options = normalizeOptions(ctx.options)
    const registrations: Registration[] = []
    try {
      const listed = await ctx.agent.list({}).catch(() => undefined)
      if (listed) {
        const ids = listed.data.map((agent) => agent.id)
        const missing = ids.length > 0 ? AGENT_IDS.filter((id) => !ids.includes(id)) : []
        if (missing.length > 0) {
          console.warn("openchoreographer: agent definitions not registered: " + missing.join(", ") + ". Run: node bin/install.mjs --force, then restart OpenCode.")
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
- On a multi-step task, write the todo list before the first tool call.
- Mark an item in_progress when work on it starts.
- Mark it completed immediately when it is done, not at the end of the turn.
- Never end a turn with open items unless blocked; say what blocks it.
- One item per verifiable action.`,
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
