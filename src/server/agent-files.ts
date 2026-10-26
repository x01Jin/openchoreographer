import { lstatSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { SUBAGENT_IDS, TEAM_IDS } from "../shared/agents"
import { clampSteps } from "../shared/settings"

export function agentDirs(location: { directory: string }): string[] {
  const candidates = [join(location.directory, ".opencode", "agents")]
  const configDir = process.env.OPENCODE_CONFIG_DIR
  if (configDir !== undefined && configDir !== "" && isAbsolute(configDir)) candidates.push(join(configDir, "agents"))
  candidates.push(join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode", "agents"))
  return [...new Set(candidates)]
}

const MAX_AGENT_FILE_BYTES = 1_000_000
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const DISABLED_SUFFIX = ".disabled"

function safeAgentPath(dir: string, fileName: string): string | undefined {
  const path = join(dir, fileName)
  try {
    if (!lstatSync(path).isFile()) return undefined
    const real = realpathSync(path)
    const root = realpathSync(dir)
    if (real.toLowerCase() !== join(root, fileName).toLowerCase()) return undefined
    if (statSync(path).size > MAX_AGENT_FILE_BYTES) return undefined
    return path
  } catch {
    return undefined
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function removeIfExists(path: string): void {
  if (exists(path)) unlinkSync(path)
}

function unsafeError(): Error {
  return new Error("openchoreographer: agent file not found or unsafe")
}

function hasFrontmatter(content: string): boolean {
  return /^---[ \t]*\r?$/m.test(content)
}

export function agentFilePath(dirs: readonly string[], id: string): string | undefined {
  if (!AGENT_ID_PATTERN.test(id)) return undefined
  for (const dir of dirs) {
    const path = safeAgentPath(dir, `${id}.md`)
    if (path !== undefined) return path
  }
  return undefined
}

export function agentStepsPath(dirs: readonly string[], id: string): string | undefined {
  if (!AGENT_ID_PATTERN.test(id)) return undefined
  for (const dir of dirs) {
    const disabled = safeAgentPath(dir, `${id}.md${DISABLED_SUFFIX}`)
    if (disabled !== undefined) return disabled
  }
  for (const dir of dirs) {
    const normal = safeAgentPath(dir, `${id}.md`)
    if (normal !== undefined) return normal
  }
  return undefined
}

function parseSteps(content: string): number | null {
  const match = content.match(/^steps:[ \t]*["']?(-?\d+)/m)
  if (!match) return null
  const n = Number(match[1])
  if (!Number.isFinite(n)) return null
  return clampSteps(n)
}

function readStepsFile(path: string): number | null {
  let content: string
  try {
    content = readFileSync(path, "utf8")
  } catch {
    return null
  }
  return parseSteps(content)
}

function writeStepsToPath(path: string, value: number): void {
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

export function readAgentSteps(dirs: readonly string[], id: string): number | null {
  const path = agentStepsPath(dirs, id)
  if (path === undefined) return null
  return readStepsFile(path)
}

export function writeAgentSteps(dirs: readonly string[], id: string, value: number): void {
  const path = agentStepsPath(dirs, id)
  if (path === undefined) throw new Error("openchoreographer: agent file not found or unsafe")
  writeStepsToPath(path, value)
}

const BACKUP_SUFFIX = ".bak"

type DisableOp = {
  normalPath: string
  disabledPath: string
  backupPath: string
  normalContent: string
  disabledContent: string | null
  oldSteps: number | null
  hadDisabled: boolean
}

function restoreDisableOp(op: DisableOp): void {
  if (!op.hadDisabled) {
    try {
      if (!exists(op.normalPath) && exists(op.disabledPath)) renameSync(op.disabledPath, op.normalPath)
    } catch {
      // Restore is best-effort; the original error below is what matters.
    }
    try {
      removeIfExists(op.backupPath)
    } catch {
      // Restore is best-effort; the original error below is what matters.
    }
    return
  }
  if (exists(op.backupPath) && !exists(op.normalPath) && exists(op.disabledPath)) {
    // The backup still holds the old disabled copy and the normal content is
    // duplicated, so rebuild in place without deleting the only copy first.
    try {
      writeFileSync(op.normalPath, op.normalContent, "utf8")
      unlinkSync(op.disabledPath)
      renameSync(op.backupPath, op.disabledPath)
    } catch {
      // Restore is best-effort; the original error below is what matters.
    }
    return
  }
  try {
    writeFileSync(op.normalPath, op.normalContent, "utf8")
  } catch {
    // Restore is best-effort; the original error below is what matters.
  }
  try {
    if (op.disabledContent !== null) writeFileSync(op.disabledPath, op.disabledContent, "utf8")
  } catch {
    // Restore is best-effort; the original error below is what matters.
  }
  try {
    if (op.disabledContent === null || readFileSync(op.disabledPath, "utf8") === op.disabledContent) {
      removeIfExists(op.backupPath)
    }
  } catch {
    // A stray backup is safer than deleting the only copy of a definition.
  }
}

function runDisableOp(op: DisableOp): void {
  // At most one stable backup per id; the next disable overwrites it.
  removeIfExists(op.backupPath)
  if (!op.hadDisabled) {
    renameSync(op.normalPath, op.disabledPath)
    return
  }
  renameSync(op.disabledPath, op.backupPath)
  try {
    renameSync(op.normalPath, op.disabledPath)
  } catch (renameErr) {
    restoreDisableOp(op)
    throw renameErr
  }
  if (op.oldSteps !== null && hasFrontmatter(op.normalContent)) {
    try {
      writeStepsToPath(op.disabledPath, op.oldSteps)
    } catch (writeErr) {
      restoreDisableOp(op)
      throw writeErr
    }
  }
  try {
    unlinkSync(op.backupPath)
  } catch (unlinkErr) {
    restoreDisableOp(op)
    throw unlinkErr
  }
}

export function disableAgentFile(dirs: readonly string[], id: string): boolean {
  if (!AGENT_ID_PATTERN.test(id)) return false
  const disabledName = `${id}.md${DISABLED_SUFFIX}`
  const ops: DisableOp[] = []
  for (const dir of dirs) {
    if (!isDir(dir)) continue
    const normalPath = join(dir, `${id}.md`)
    if (!exists(normalPath)) continue
    if (safeAgentPath(dir, `${id}.md`) === undefined) throw unsafeError()
    const disabledPath = join(dir, disabledName)
    let hadDisabled = false
    let disabledContent: string | null = null
    let oldSteps: number | null = null
    if (exists(disabledPath)) {
      if (safeAgentPath(dir, disabledName) === undefined) throw unsafeError()
      hadDisabled = true
      disabledContent = readFileSync(disabledPath, "utf8")
      oldSteps = parseSteps(disabledContent)
    }
    const normalContent = readFileSync(normalPath, "utf8")
    ops.push({ normalPath, disabledPath, backupPath: join(dir, `${disabledName}${BACKUP_SUFFIX}`), normalContent, disabledContent, oldSteps, hadDisabled })
  }
  const completed: DisableOp[] = []
  try {
    for (const op of ops) {
      runDisableOp(op)
      completed.push(op)
    }
  } catch (err) {
    for (const op of completed.reverse()) {
      try {
        restoreDisableOp(op)
      } catch {
        // Restore is best-effort; the original error below is what matters.
      }
    }
    throw err
  }
  return completed.length > 0
}

type EnableOp = {
  normalPath: string
  disabledPath: string
  backupPath: string
  normalContent: string | null
  disabledContent: string
  steps: number | null
  hadNormal: boolean
}

function restoreEnableOp(op: EnableOp): void {
  if (!op.hadNormal) {
    try {
      if (!exists(op.disabledPath) && exists(op.normalPath)) renameSync(op.normalPath, op.disabledPath)
    } catch {
      // Restore is best-effort; the original error below is what matters.
    }
    try {
      removeIfExists(op.backupPath)
    } catch {
      // Restore is best-effort; the original error below is what matters.
    }
    return
  }
  if (exists(op.backupPath) && exists(op.normalPath)) {
    // The backup still holds the disabled copy; fix the normal file first so
    // the only copy is never deleted, then move the backup back.
    try {
      if (op.normalContent !== null) writeFileSync(op.normalPath, op.normalContent, "utf8")
      renameSync(op.backupPath, op.disabledPath)
    } catch {
      // Restore is best-effort; the original error below is what matters.
    }
    return
  }
  try {
    if (op.normalContent !== null) writeFileSync(op.normalPath, op.normalContent, "utf8")
  } catch {
    // Restore is best-effort; the original error below is what matters.
  }
  try {
    writeFileSync(op.disabledPath, op.disabledContent, "utf8")
  } catch {
    // Restore is best-effort; the original error below is what matters.
  }
  try {
    if (readFileSync(op.disabledPath, "utf8") === op.disabledContent) removeIfExists(op.backupPath)
  } catch {
    // A stray backup is safer than deleting the only copy of a definition.
  }
}

function runEnableOp(op: EnableOp): void {
  // At most one stable backup per id; the next enable overwrites it.
  removeIfExists(op.backupPath)
  if (!op.hadNormal) {
    renameSync(op.disabledPath, op.normalPath)
    return
  }
  renameSync(op.disabledPath, op.backupPath)
  if (!hasFrontmatter(op.normalContent ?? "")) {
    // Leave the normal file alone: without frontmatter there is nowhere to
    // hold the steps. Put the backup back and report the failed enable, so
    // the valid definition survives under its disabled name with no .bak.
    try {
      renameSync(op.backupPath, op.disabledPath)
    } catch {
      try {
        restoreEnableOp(op)
      } catch {
        // Restore is best-effort; the frontmatter error below is what matters.
      }
    }
    throw new Error("openchoreographer: agent frontmatter not found")
  }
  if (op.steps !== null) {
    try {
      writeStepsToPath(op.normalPath, op.steps)
    } catch (writeErr) {
      restoreEnableOp(op)
      throw writeErr
    }
  }
  try {
    unlinkSync(op.backupPath)
  } catch (unlinkErr) {
    restoreEnableOp(op)
    throw unlinkErr
  }
}

export function enableAgentFile(dirs: readonly string[], id: string): boolean {
  if (!AGENT_ID_PATTERN.test(id)) return false
  const disabledName = `${id}.md${DISABLED_SUFFIX}`
  const ops: EnableOp[] = []
  for (const dir of dirs) {
    if (!isDir(dir)) continue
    const disabledPath = join(dir, disabledName)
    if (!exists(disabledPath)) continue
    if (safeAgentPath(dir, disabledName) === undefined) throw unsafeError()
    const disabledContent = readFileSync(disabledPath, "utf8")
    const normalPath = join(dir, `${id}.md`)
    let hadNormal = false
    let normalContent: string | null = null
    if (exists(normalPath)) {
      if (safeAgentPath(dir, `${id}.md`) === undefined) throw unsafeError()
      hadNormal = true
      normalContent = readFileSync(normalPath, "utf8")
    }
    ops.push({ normalPath, disabledPath, backupPath: join(dir, `${disabledName}${BACKUP_SUFFIX}`), normalContent, disabledContent, steps: parseSteps(disabledContent), hadNormal })
  }
  const completed: EnableOp[] = []
  try {
    for (const op of ops) {
      runEnableOp(op)
      completed.push(op)
    }
  } catch (err) {
    for (const op of completed.reverse()) {
      try {
        restoreEnableOp(op)
      } catch {
        // Restore is best-effort; the original error below is what matters.
      }
    }
    throw err
  }
  return completed.length > 0
}

export function syncAgentFiles(dirs: readonly string[], disabled: readonly string[]): boolean {
  const off = new Set(disabled)
  let changed = false
  for (const id of SUBAGENT_IDS) {
    if (off.has(id)) {
      if (disableAgentFile(dirs, id)) changed = true
    } else if (enableAgentFile(dirs, id)) changed = true
  }
  return changed
}

const ORCHESTRATOR_FULL_NAME = "orchestrator.md.full"
const ORCHESTRATOR_STATE_NAME = "orchestrator.md.full.json"
const ORCHESTRATOR_STATE_MAX_BYTES = 10000

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

function stripLegacyOrchestratorMarkers(content: string): string {
  let next = content
  for (const id of SUBAGENT_IDS) {
    next = next.split(`\`${id}\` (if enabled)`).join(`\`${id}\``)
  }
  return next
}

function splitOrchestratorFile(content: string): { head: string, body: string, eol: string } {
  const eol = content.includes("\r\n") ? "\r\n" : "\n"
  const lines = content.split(/\r\n|\n/)
  let closing = -1
  if (/^---[ \t]*$/.test(lines[0] ?? "")) {
    for (let i = 1; i < lines.length; i++) {
      if (/^---[ \t]*$/.test(lines[i])) {
        closing = i
        break
      }
    }
  }
  if (closing < 0) return { head: "", body: content, eol }
  return { head: lines.slice(0, closing + 1).join(eol) + eol, body: lines.slice(closing + 1).join(eol), eol }
}

function pruneOrchestratorBody(body: string, off: ReadonlySet<string>): string {
  let next = stripLegacyOrchestratorMarkers(body)
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

function pruneOrchestratorFile(content: string, off: ReadonlySet<string>): string {
  const { head, body, eol } = splitOrchestratorFile(stripLegacyOrchestratorMarkers(content))
  return head + pruneOrchestratorBody(body.split(/\r\n|\n/).join("\n"), off).split("\n").join(eol)
}

function readOrchestratorSidecar(sidecar: string): string | null {
  try {
    if (!lstatSync(sidecar).isFile()) return null
    if (statSync(sidecar).size > MAX_AGENT_FILE_BYTES) return null
    return readFileSync(sidecar, "utf8")
  } catch {
    return null
  }
}

function readOrchestratorState(state: string): string[] {
  try {
    if (!lstatSync(state).isFile()) return []
    if (statSync(state).size > ORCHESTRATOR_STATE_MAX_BYTES) return []
    const parsed: unknown = JSON.parse(readFileSync(state, "utf8"))
    if (typeof parsed !== "object" || parsed === null) return []
    const list = (parsed as { disabled?: unknown }).disabled
    if (!Array.isArray(list)) return []
    const valid = new Set(SUBAGENT_IDS)
    const out: string[] = []
    for (const entry of list) {
      if (typeof entry !== "string" || !valid.has(entry) || out.includes(entry)) continue
      if (out.length >= 32) break
      out.push(entry)
    }
    return out
  } catch {
    return []
  }
}

function writeOrchestratorState(state: string, disabled: readonly string[]): boolean {
  const valid = new Set(SUBAGENT_IDS)
  const out: string[] = []
  for (const id of disabled) {
    if (!valid.has(id) || out.includes(id)) continue
    if (out.length >= 32) break
    out.push(id)
  }
  const next = JSON.stringify({ disabled: out })
  let current: string | null = null
  try {
    current = readFileSync(state, "utf8")
  } catch {
    current = null
  }
  if (current === next) return false
  writeFileSync(state, next, "utf8")
  return true
}

export function syncOrchestratorRules(dirs: readonly string[], disabled: readonly string[]): boolean {
  const path = agentFilePath(dirs, "orchestrator")
  if (path === undefined) return false
  let live: string
  try {
    live = readFileSync(path, "utf8")
  } catch {
    return false
  }
  const sidecar = join(dirname(path), ORCHESTRATOR_FULL_NAME)
  const state = join(dirname(path), ORCHESTRATOR_STATE_NAME)
  const off = new Set(disabled)
  if (off.size === 0) {
    const full = readOrchestratorSidecar(sidecar)
    if (full === null) return false
    const liveSteps = parseSteps(live)
    let restored = full
    if (liveSteps !== null) restored = restored.replace(/^steps:[^\r\n]*/m, `steps: ${liveSteps}`)
    restored = stripLegacyOrchestratorMarkers(restored)
    if (restored === live) {
      removeIfExists(sidecar)
      removeIfExists(state)
      return false
    }
    writeFileSync(path, restored, "utf8")
    removeIfExists(sidecar)
    removeIfExists(state)
    return true
  }
  const cleaned = stripLegacyOrchestratorMarkers(live)
  const existing = readOrchestratorSidecar(sidecar)
  const previous = new Set(readOrchestratorState(state))
  let full: string
  let changed = false
  if (existing === null) {
    full = cleaned
    writeFileSync(sidecar, full, "utf8")
    changed = true
  } else if (cleaned === pruneOrchestratorFile(existing, previous) || cleaned === pruneOrchestratorFile(existing, off) || cleaned === existing) {
    full = existing
  } else {
    full = cleaned
    writeFileSync(sidecar, full, "utf8")
    changed = true
  }
  const pruned = pruneOrchestratorFile(full, off)
  if (pruned !== live) {
    writeFileSync(path, pruned, "utf8")
    changed = true
  }
  if (writeOrchestratorState(state, disabled)) changed = true
  return changed
}

const TEAM_LINE_PATTERN = /Team: [^.\n]*\./

export function syncTeamLines(dirs: readonly string[], disabled: readonly string[]): boolean {
  const off = new Set(disabled)
  const enabled = TEAM_IDS.filter((id) => !off.has(id))
  const replacement = enabled.length > 0 ? `Team: ${enabled.join(", ")}.` : ""
  let changed = false
  for (const id of TEAM_IDS) {
    if (off.has(id)) continue
    const path = agentFilePath(dirs, id)
    if (path === undefined) continue
    let content: string
    try {
      content = readFileSync(path, "utf8")
    } catch {
      continue
    }
    const match = content.match(TEAM_LINE_PATTERN)
    if (match === null) continue
    let next: string
    if (replacement === "") {
      next = content.replace(/Team: [^.\n]*\. ?/, "")
    } else {
      next = content.replace(TEAM_LINE_PATTERN, replacement)
    }
    if (next === content) continue
    writeFileSync(path, next, "utf8")
    changed = true
  }
  return changed
}
