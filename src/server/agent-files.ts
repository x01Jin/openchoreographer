import { lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { clampSteps } from "../shared/settings"

export function agentDirs(location: { directory: string }): string[] {
  const candidates = [
    join(location.directory, ".opencode", "agents"),
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode", "agents"),
  ]
  return [...new Set(candidates)]
}

const MAX_AGENT_FILE_BYTES = 1_000_000

export function agentFilePath(dirs: readonly string[], id: string): string | undefined {
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
