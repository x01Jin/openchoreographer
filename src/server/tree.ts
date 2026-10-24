import type { Plugin } from "@opencode/plugin"
import { sanitizeForContext } from "../shared/text"

export type TreeEntry = { readonly file: string; readonly status: string }

export function treeKey(entry: TreeEntry): string {
  return entry.file + ":" + entry.status
}

const TREE_CACHE_MS = 1000
const treeCache = new Map<string, { at: number; promise: Promise<readonly TreeEntry[] | undefined> }>()

// The baseline read is shared per location for 1000 ms so parallel spawns reuse one in-flight or settled VCS call,
// failures included. Trade-off: a change made within the window before a spawn is treated as pre-existing
// by the retry gate.
export async function readTree(ctx: Plugin.Context, fresh = false): Promise<readonly TreeEntry[] | undefined> {
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

export function changedFiles(baseline: ReadonlySet<string>, current: readonly TreeEntry[]): string[] {
  const changed: string[] = []
  for (const entry of current) {
    if (baseline.has(treeKey(entry))) continue
    if (!changed.includes(entry.file)) changed.push(entry.file)
  }
  return changed
}

export function changedTreeError(error: unknown, changed: readonly string[]): Error {
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
