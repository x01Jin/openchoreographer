import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import { AGENT_IDS } from "../shared/agents"

type Context = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]

export type AgentPermission = { action: string; resource: string; effect: "allow" | "deny" | "ask" }

export type AgentDefinition = {
  id: string
  description: string
  mode: "primary" | "subagent" | "all"
  color?: string
  system: string
  permissions: AgentPermission[]
}

const AGENTS_DIR = fileURLToPath(new URL("../../agents/", import.meta.url))
const MAX_AGENT_BYTES = 1_000_000
const VALID_EFFECTS = new Set(["allow", "deny", "ask"])
const RETIRED_AGENT_IDS: readonly string[] = [
  "reviewer-general",
  "reviewer-oop",
  "reviewer-functional",
  "reviewer-procedural",
  "reviewer-concurrent",
  "reviewer-distributed",
  "reviewer-data",
  "reviewer-api",
  "reviewer-frontend",
  "reviewer-performance",
  "reviewer-testing",
]

function malformed(file: string, reason: string): Error {
  return new Error(`openchoreographer: ${file} ${reason}`)
}

function unquote(raw: string): string {
  const value = raw.trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
  return value
}

function scalar(header: readonly string[], key: string): string {
  const prefix = `${key}:`
  const line = header.find((entry) => entry.startsWith(prefix))
  if (line === undefined) return ""
  return unquote(line.slice(prefix.length))
}

function parsePermissions(header: readonly string[], file: string): AgentPermission[] {
  const start = header.findIndex((line) => /^permissions:\s*$/.test(line))
  if (start < 0) return []
  const permissions: AgentPermission[] = []
  let current: Partial<AgentPermission> | undefined
  for (let index = start + 1; index < header.length; index += 1) {
    const line = header[index]
    if (line.trim() === "" || !/^\s+/.test(line)) break
    const item = line.match(/^\s*-\s*([A-Za-z]+):\s*(.*)$/)
    if (item !== null) {
      current = { [item[1]]: unquote(item[2]) }
      permissions.push(current as AgentPermission)
      continue
    }
    const field = line.match(/^\s+([A-Za-z]+):\s*(.*)$/)
    if (field === null || current === undefined) throw malformed(file, "has a malformed permissions block")
    ;(current as Record<string, string>)[field[1]] = unquote(field[2])
  }
  for (const permission of permissions) {
    if (
      typeof permission.action !== "string" ||
      permission.action === "" ||
      typeof permission.resource !== "string" ||
      !VALID_EFFECTS.has(permission.effect)
    ) {
      throw malformed(file, "has an incomplete permission entry")
    }
  }
  return permissions
}

export function parseAgentMarkdown(file: string, content: string): AgentDefinition {
  if (content.length > MAX_AGENT_BYTES) throw malformed(file, "is larger than 1 MB")
  const lines = content.replace(/\r\n/g, "\n").split("\n")
  if ((lines[0] ?? "").trim() !== "---") throw malformed(file, "does not start with frontmatter")
  let closing = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "---") {
      closing = index
      break
    }
  }
  if (closing < 0) throw malformed(file, "has unterminated frontmatter")
  const header = lines.slice(1, closing)
  const id = file.replace(/\.md$/, "")
  const description = scalar(header, "description")
  const mode = scalar(header, "mode")
  const color = scalar(header, "color")
  if (description === "") throw malformed(file, "has no description")
  if (mode !== "primary" && mode !== "subagent" && mode !== "all") throw malformed(file, `has unsupported mode "${mode}"`)
  return {
    id,
    description,
    mode,
    ...(color === "" ? {} : { color }),
    system: lines.slice(closing + 1).join("\n").trim(),
    permissions: parsePermissions(header, file),
  }
}

export function readAgentDefinitions(directory: string = AGENTS_DIR): AgentDefinition[] {
  const files = readdirSync(directory)
    .filter((file) => file.endsWith(".md"))
    .sort()
  const definitions = new Map<string, AgentDefinition>()
  for (const file of files) {
    const definition = parseAgentMarkdown(file, readFileSync(join(directory, file), "utf8"))
    if (!AGENT_IDS.includes(definition.id)) throw malformed(file, "is not a known agent id")
    definitions.set(definition.id, definition)
  }
  const missing = AGENT_IDS.filter((id) => !definitions.has(id))
  if (missing.length > 0) throw new Error(`openchoreographer: missing agent definitions: ${missing.join(", ")}`)
  return AGENT_IDS.map((id) => definitions.get(id) as AgentDefinition)
}

export async function registerChoreographerAgents(ctx: Context) {
  const definitions = readAgentDefinitions()
  return ctx.agent.transform((editor) => {
    for (const id of RETIRED_AGENT_IDS) editor.remove(id)
    for (const definition of definitions) {
      editor.update(definition.id, (agent) => {
        agent.name = definition.id as typeof agent.name
        agent.description = definition.description
        agent.mode = definition.mode
        if (definition.color === undefined) delete agent.color
        else agent.color = definition.color
        agent.system = definition.system
        agent.permissions = definition.permissions.map((permission) => ({ ...permission }))
      })
    }
  })
}
