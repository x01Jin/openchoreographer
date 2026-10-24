import type { Plugin } from "@opencode/plugin"

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

export function todoTools(ctx: Plugin.Context) {
  return ctx.tool.transform((editor) => {
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
  })
}
