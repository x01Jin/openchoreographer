import type { AgentInfo } from "@opencode/client"
import { displayWidth } from "../shared/text"

export type ModelRefLike = { id: string; providerID: string; variant?: string }

export type Section = "agents" | "primary" | "workers" | "reviewers" | "todos"

export type TodoItem = {
  id?: string
  content: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
}

export const NAME_WIDTH = 15
export const MODEL_WIDTH = 15
export const TODO_LIMIT = 12

export const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"]

export function normalizeTodoStatus(value: unknown): TodoItem["status"] {
  return typeof value === "string" && TODO_STATUSES.includes(value)
    ? (value as TodoItem["status"])
    : "pending"
}

export type GraphemeSegmenter = { segment(value: string): Iterable<{ segment: string }> }

export function createSegmenter(): GraphemeSegmenter | undefined {
  try {
    const Ctor = (Intl as unknown as { Segmenter?: new (locales?: string, options?: { granularity: string }) => GraphemeSegmenter }).Segmenter
    return Ctor ? new Ctor(undefined, { granularity: "grapheme" }) : undefined
  } catch {
    return undefined
  }
}

export const segmenter = createSegmenter()

export function sanitize(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
}

const truncateCache = new Map<string, string>()

export function truncate(value: string, width: number): string {
  const key = `${width}:${value}`
  const hit = truncateCache.get(key)
  if (hit !== undefined) return hit
  const clean = sanitize(value)
  let result: string
  if (/^[\x00-\x7F]*$/.test(clean) && clean.length <= width) {
    result = clean
  } else {
    const cells = segmenter ? Array.from(segmenter.segment(clean), (part) => part.segment) : Array.from(clean)
    let total = 0
    for (const cell of cells) total += displayWidth(cell)
    if (total <= width) result = clean
    else {
      let used = 0
      let end = 0
      for (; end < cells.length; end += 1) {
        const cellWidth = displayWidth(cells[end])
        if (used + cellWidth > width - 1) break
        used += cellWidth
      }
      result = cells.slice(0, end).join("") + "…"
    }
  }
  if (truncateCache.size > 512) truncateCache.clear()
  truncateCache.set(key, result)
  return result
}

export function modelName(ref: ModelRefLike, index: Map<string, string>): string {
  const name = index.get(`${ref.providerID}/${ref.id}`) ?? `${ref.providerID}/${ref.id}`
  return ref.variant ? `${name}#${ref.variant}` : name
}

export const PALETTE = ["#8aadf4", "#a6da95", "#eed49f", "#f5a97f", "#c6a0f6", "#8bd5ca", "#ed8796", "#ee99a0"]

export function hashColor(id: string): string {
  let hash = 0
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) >>> 0
  return PALETTE[hash % PALETTE.length]
}

export function agentColor(agent: AgentInfo | undefined, id: string | undefined): string {
  return agent?.color ?? hashColor(id ?? "unknown")
}

export function hueHex(index: number, phase: number): string {
  const hue = (((index * 47 + phase) % 360) + 360) % 360
  const chroma = (1 - Math.abs(2 * 0.65 - 1)) * 0.7
  const segment = hue / 60
  const second = chroma * (1 - Math.abs((segment % 2) - 1))
  const match = 0.65 - chroma / 2
  const [r, g, b] =
    segment < 1 ? [chroma, second, 0] :
    segment < 2 ? [second, chroma, 0] :
    segment < 3 ? [0, chroma, second] :
    segment < 4 ? [0, second, chroma] :
    segment < 5 ? [second, 0, chroma] :
    [chroma, 0, second]
  const channel = (value: number) => Math.round((value + match) * 255).toString(16).padStart(2, "0")
  return `#${channel(r)}${channel(g)}${channel(b)}`
}

export const FLOW = ["#8aadf4", "#b4befe", "#c6a0f6", "#f5c2e7", "#f38ba8", "#fab387", "#f9e2af", "#a6e3a1", "#94e2d5", "#89dceb"]
