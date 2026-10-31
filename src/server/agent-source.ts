import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import { AGENT_IDS, ORCHESTRATOR_ID, SUBAGENT_IDS, TEAM_IDS } from "../shared/agents"

type Context = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]

export type AgentPermission = { action: string; resource: string; effect: "allow" | "deny" | "ask" }

export type AgentDefinition = {
  id: string
  description: string
  mode: "primary" | "subagent" | "all"
  color?: string
  steps?: number
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

function scalar(header: readonly string[], file: string, key: string): string {
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
  const description = scalar(header, file, "description")
  const mode = scalar(header, file, "mode")
  const color = scalar(header, file, "color")
  const rawSteps = scalar(header, file, "steps")
  if (description === "") throw malformed(file, "has no description")
  if (mode !== "primary" && mode !== "subagent" && mode !== "all") throw malformed(file, `has unsupported mode "${mode}"`)
  let steps: number | undefined
  if (rawSteps !== "") {
    const value = Number(rawSteps)
    if (!Number.isInteger(value) || value < 1) throw malformed(file, `has invalid steps "${rawSteps}"`)
    steps = value
  }
  return {
    id,
    description,
    mode,
    ...(color === "" ? {} : { color }),
    ...(steps === undefined ? {} : { steps }),
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

const DESIGNER_RULE = "- Use `designer` before `frontend` when a task changes a flow, state, empty/error case, or user-facing copy; paste its `STATES` and `COPY` into the `frontend` prompt, and never run it alone because it cannot edit."
const WRITER_RULE = "- Use `writer` once behavior and interface have settled, for README, docs, changelog, and migration notes; expect `BLOCKED` when the docs need a code change."
const EXPLORE_CLAUSE = "; spawn `explore` only when the sweep would flood your context with file bodies it can compress into a map"
const EXPLORE_MAP_RULE = "- When `explore` ran, paste its map verbatim into every child prompt so the child does not rediscover the tree."
const REVIEWER_SECURITY_SENTENCE = " Add `reviewer-security` when the `Risk:` line from the `diff` tool reports a signal, and also when you judge the change touches input handling, deserialization, SSRF, or path handling, which the signals do not detect."
const REVIEWER_SCOPE_RULE = "- Run `reviewer-scope` only when the value of the work is genuinely unclear: a rewrite, a new subsystem, or work that may already exist. It is advisory: report its verdict, never block on it."
const REVIEWER_PLAN_RULE = "- Run `reviewer-plan` on the written plan before the first delegation, on Tier 3 work only. Fix blocker findings before delegating."
const REVIEWER_EXECUTION_RULE = "- Run `reviewer-execution` on the revised plan when `reviewer-plan` found blockers, or when the plan cites files or symbols you have not verified. A `VERDICT: BLOCK` stops the task until the plan is corrected."
const REVIEWER_EXECUTION_RULE_NO_PLAN = "- Run `reviewer-execution` on the revised plan when the plan cites files or symbols you have not verified. A `VERDICT: BLOCK` stops the task until the plan is corrected."
const TESTER_CLAUSE = ", plus `tester` if behavior changed"
const REVIEWER_SECURITY_TIER3_CLAUSE = " plus `reviewer-security`"
const PLAN_STAGE_HEADER = "Plan stage, before the first delegation:"
const SKIP_PLAN_REVIEW_RULE = "- Skip plan review on Tier 1 and Tier 2 work."
const PLAN_REVIEWER_IDS = ["reviewer-scope", "reviewer-plan", "reviewer-execution"]

export const ORCHESTRATOR_RULE_LINES: readonly string[] = [
  DESIGNER_RULE,
  WRITER_RULE,
  EXPLORE_MAP_RULE,
  REVIEWER_SCOPE_RULE,
  REVIEWER_PLAN_RULE,
  REVIEWER_EXECUTION_RULE,
  SKIP_PLAN_REVIEW_RULE,
]

function stripLegacyMarkers(content: string): string {
  let next = content
  for (const id of SUBAGENT_IDS) next = next.split(`\`${id}\` (if enabled)`).join(`\`${id}\``)
  return next
}

export function pruneOrchestratorSystem(system: string, disabled: readonly string[]): string {
  const off = new Set(disabled)
  let next = stripLegacyMarkers(system)
  const drop = new Set<string>()
  if (off.has("designer")) drop.add(DESIGNER_RULE)
  if (off.has("writer")) drop.add(WRITER_RULE)
  if (off.has("explore")) drop.add(EXPLORE_MAP_RULE)
  if (off.has("reviewer-scope")) drop.add(REVIEWER_SCOPE_RULE)
  if (off.has("reviewer-plan")) drop.add(REVIEWER_PLAN_RULE)
  if (off.has("reviewer-execution")) drop.add(REVIEWER_EXECUTION_RULE)
  if (drop.size > 0) next = next.split("\n").filter((line) => !drop.has(line)).join("\n")
  if (PLAN_REVIEWER_IDS.every((id) => off.has(id))) {
    const lines = next.split("\n")
    const start = lines.findIndex((line) => line === PLAN_STAGE_HEADER)
    if (start >= 0) {
      const end = lines.findIndex((line, index) => index > start && line === SKIP_PLAN_REVIEW_RULE)
      if (end > start) {
        lines.splice(start, end - start + 1)
        next = lines.join("\n")
      }
    }
  }
  if (off.has("explore")) next = next.split(EXPLORE_CLAUSE).join("")
  if (off.has("reviewer-plan") && !off.has("reviewer-execution")) next = next.split(REVIEWER_EXECUTION_RULE).join(REVIEWER_EXECUTION_RULE_NO_PLAN)
  if (off.has("reviewer-security")) next = next.split(REVIEWER_SECURITY_SENTENCE).join("")
  if (off.has("tester")) next = next.split(TESTER_CLAUSE).join("")
  if (off.has("reviewer-security")) next = next.split(REVIEWER_SECURITY_TIER3_CLAUSE).join("")
  return next.replace(/\n{3,}/g, "\n\n")
}

const TEAM_LINE_PATTERN = /Team: [^.\n]*\./

export function rewriteTeamLine(system: string, disabled: readonly string[]): string {
  const match = system.match(TEAM_LINE_PATTERN)
  if (match === null) return system
  const enabled = TEAM_IDS.filter((id) => !disabled.includes(id))
  if (enabled.length === 0) return system.replace(/Team: [^.\n]*\. ?/, "")
  return system.replace(TEAM_LINE_PATTERN, `Team: ${enabled.join(", ")}.`)
}

export async function registerChoreographerAgents(ctx: Context, getDisabled: () => readonly string[]) {
  const definitions = readAgentDefinitions()
  return ctx.agent.transform((editor) => {
    const disabled = getDisabled()
    const off = new Set(disabled)
    for (const id of [...SUBAGENT_IDS, ...RETIRED_AGENT_IDS]) {
      if (off.has(id) || RETIRED_AGENT_IDS.includes(id)) editor.remove(id)
    }
    for (const definition of definitions) {
      if (off.has(definition.id)) continue
      editor.update(definition.id, (agent) => {
        agent.name = definition.id as typeof agent.name
        agent.description = definition.description
        agent.mode = definition.mode
        if (definition.color === undefined) delete agent.color
        else agent.color = definition.color
        if (definition.steps === undefined) delete agent.steps
        else agent.steps = definition.steps
        agent.system =
          definition.id === ORCHESTRATOR_ID ? pruneOrchestratorSystem(definition.system, disabled) : rewriteTeamLine(definition.system, disabled)
        agent.permissions = definition.permissions.map((permission) => ({ ...permission }))
      })
    }
  })
}
