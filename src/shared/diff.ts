import { sanitizeForContext } from "./text"

export type ValidatedDiffInput = {
  mode: "working" | "branch" | "committed"
  base: string | undefined
  context: number
  path: string | undefined
  stat: boolean
}

export const MAX_DIFF_CHARS = 60_000

export function validateDiffInput(input: unknown): ValidatedDiffInput {
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
  const rawStat = record.stat
  const stat = typeof rawStat === "boolean" ? rawStat : false
  return { mode, base, context, path, stat }
}

type ChangeFile = { readonly file: string; readonly patch: string; readonly additions: number; readonly deletions: number }

// Keyword signals are a floor, not a ceiling: path traversal, SSRF, and deserialization stay judgment calls.
export function summarizeChanges(files: readonly ChangeFile[]): string {
  let additions = 0
  let deletions = 0
  for (const file of files) {
    additions += file.additions
    deletions += file.deletions
  }
  const categories = [
    { name: "auth", pattern: /authenticat|authoriz|password|credential|login|jwt|oauth|\bpermission/i },
    { name: "secrets", pattern: /secret|api[_-]?key|private[_-]?key|\.env\b|BEGIN [A-Z ]*PRIVATE KEY/i },
    { name: "sql", pattern: /\bsql\b|\bselect\b[^\n]*\bfrom\b[^\n]*\b(?:where|join|group\s+by|order\s+by|limit)\b|insert\s+into\s|update\s+\w+\s+set\s|delete\s+from\s|migration/i },
    { name: "shell", pattern: /child_process|subprocess|\bexecSync\b|\bspawnSync\b|\bsystem\(/ },
    { name: "html", pattern: /innerHTML|dangerouslySetInnerHTML|v-html|render_template/ },
  ] as const
  const matched: string[] = []
  let sqlMatched = false
  for (const category of categories) {
    const hit = files.find((file) => category.pattern.test(`${file.file}\n${file.patch}`))
    if (hit !== undefined) {
      matched.push(`${category.name} (${sanitizeForContext(hit.file)})`)
      if (category.name === "sql") sqlMatched = true
    }
  }
  const signals = matched.length === 0 ? "none" : matched.slice(0, 3).join(", ") + (matched.length > 3 ? ` +${matched.length - 3}` : "")
  const lenses = ["correctness", ...(matched.length > 0 ? ["security"] : []), ...(sqlMatched ? ["data"] : [])].join(", ")
  return `Risk: ${files.length} files, +${additions} -${deletions}. Signals: ${signals}. Lenses: ${lenses}.`
}

type CollapsedPatch = { patch: string; additions: number; deletions: number }

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

type HunkLine = {
  readonly kind: "context" | "add" | "del" | "marker"
  readonly raw: string
  readonly anchor: number
}

function countPatchLines(patch: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1
  }
  return { additions, deletions }
}

function splitTrailingCr(text: string): { text: string; cr: boolean } {
  return text.endsWith("\r") ? { text: text.slice(0, -1), cr: true } : { text, cr: false }
}

// A CRLF working tree over LF blobs makes the provider emit every line as a -/+ pair that differs only by the CR.
// Removing those pairs keeps real edits visible; anything that is not a lone CR difference survives untouched.
export function collapseEolOnlyChanges(patch: string): CollapsedPatch | undefined {
  const unchanged = (): CollapsedPatch => ({ patch, ...countPatchLines(patch) })
  try {
    // Without a CR no pair can collapse, so the patch and its raw counts are already the answer.
    if (!patch.includes("\r")) return unchanged()
    const endsWithNewline = patch.endsWith("\n")
    const lines = (endsWithNewline ? patch.slice(0, -1) : patch).split("\n")
    const out: string[] = []
    let additions = 0
    let deletions = 0
    let sawHunk = false
    let keptHunks = 0
    let droppedHunks = 0
    let header: string | undefined
    let body: HunkLine[] = []

    const flush = (): void => {
      if (header === undefined) return
      const current = header
      const currentBody = body
      header = undefined
      body = []

      type Side = { readonly index: number; readonly text: string; readonly cr: boolean }
      const dels: Side[] = []
      const adds: Side[] = []
      currentBody.forEach((line, index) => {
        if (line.kind !== "del" && line.kind !== "add") return
        const parsed = splitTrailingCr(line.raw.slice(1))
        const side = { index, text: parsed.text, cr: parsed.cr }
        if (line.kind === "del") dels.push(side)
        else adds.push(side)
      })

      const consumed = new Set<number>()
      let pairs = 0
      // Only a lone CR difference on matching text is EOL noise; the same CR state on both sides is a real change.
      const pairUp = (del: Side, add: Side): void => {
        if (del.cr === add.cr) return
        consumed.add(del.index)
        consumed.add(add.index)
        pairs += 1
      }

      const sameItems = (left: readonly string[], right: readonly string[]): boolean => {
        if (left.length !== right.length) return false
        const counts = new Map<string, number>()
        for (const text of left) counts.set(text, (counts.get(text) ?? 0) + 1)
        for (const text of right) {
          const count = counts.get(text)
          if (count === undefined) return false
          if (count === 1) counts.delete(text)
          else counts.set(text, count - 1)
        }
        return counts.size === 0
      }

      // Matched indices of a longest common subsequence, in order. The table is flat because the backtrack needs
      // the neighbours a pair of rolling rows overwrites; the size is guarded before this is called.
      const lcsMatches = (left: readonly string[], right: readonly string[]): Array<readonly [number, number]> => {
        const rows = left.length
        const cols = right.length
        const width = cols + 1
        const table = new Int32Array((rows + 1) * width)
        for (let i = rows - 1; i >= 0; i -= 1) {
          for (let j = cols - 1; j >= 0; j -= 1) {
            table[i * width + j] =
              left[i] === right[j]
                ? table[(i + 1) * width + j + 1] + 1
                : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
          }
        }
        const matches: Array<readonly [number, number]> = []
        let i = 0
        let j = 0
        while (i < rows && j < cols) {
          if (left[i] === right[j]) {
            matches.push([i, j])
            i += 1
            j += 1
          } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i += 1
          else j += 1
        }
        return matches
      }

      const delTexts = dels.map((del) => del.text)
      const addTexts = adds.map((add) => add.text)
      // Same text in the same order is the CRLF whole-file rewrite, so positions pair up. A pure reorder of the same
      // texts is a real change and collapses nothing. Everything else pairs only what an LCS can line up, so any
      // line it cannot account for stays visible.
      const sameOrder = delTexts.length === addTexts.length && delTexts.every((text, i) => text === addTexts[i])
      const reordered = !sameOrder && sameItems(delTexts, addTexts)
      if (sameOrder) {
        dels.forEach((del, i) => pairUp(del, adds[i]))
      } else if (!reordered && dels.length * adds.length <= 4_000_000) {
        // A bigger product would allocate gigabytes for the table, so that hunk stays uncollapsed.
        for (const [delIndex, addIndex] of lcsMatches(delTexts, addTexts)) pairUp(dels[delIndex], adds[addIndex])
      }

      const kept = currentBody.filter((line, index) => {
        if (consumed.has(index)) return false
        if (line.kind === "marker") return line.anchor >= 0 && !consumed.has(line.anchor)
        return true
      })
      const keptAdditions = kept.filter((line) => line.kind === "add").length
      const keptDeletions = kept.filter((line) => line.kind === "del").length

      if (pairs === 0) {
        out.push(current, ...currentBody.map((line) => line.raw))
        additions += keptAdditions
        deletions += keptDeletions
        keptHunks += 1
        return
      }
      if (keptAdditions === 0 && keptDeletions === 0) {
        droppedHunks += 1
        return
      }
      const match = HUNK_HEADER.exec(current)
      if (match === null) throw new Error("unparsable hunk header")
      const oldCount = kept.filter((line) => line.kind === "context" || line.kind === "del").length
      const newCount = kept.filter((line) => line.kind === "context" || line.kind === "add").length
      // Consumed pairs before the first surviving line move that line down both sides, so the header start must
      // advance with them. Context is never consumed, so a hunk that opens with context keeps its start.
      const firstKeptIndex = currentBody.findIndex((line, index) => {
        if (consumed.has(index)) return false
        if (line.kind === "marker") return line.anchor >= 0 && !consumed.has(line.anchor)
        return true
      })
      let droppedOld = 0
      let droppedNew = 0
      for (let index = 0; index < firstKeptIndex; index += 1) {
        if (!consumed.has(index)) continue
        const kind = currentBody[index].kind
        if (kind === "del") droppedOld += 1
        else if (kind === "add") droppedNew += 1
      }
      const suffix = (count: number) => (count === 1 ? "" : `,${count}`)
      // An empty side points at the line before the hunk, which is git's convention for a zero count.
      const start = (line: number, count: number) => (count === 0 ? line - 1 : line)
      const oldStart = start(Number(match[1]) + droppedOld, oldCount)
      const newStart = start(Number(match[3]) + droppedNew, newCount)
      out.push(`@@ -${oldStart}${suffix(oldCount)} +${newStart}${suffix(newCount)} @@${match[5]}`, ...kept.map((line) => line.raw))
      additions += keptAdditions
      deletions += keptDeletions
      keptHunks += 1
    }

    for (const line of lines) {
      if (HUNK_HEADER.test(line)) {
        flush()
        header = line
        sawHunk = true
        continue
      }
      if (header === undefined) {
        out.push(line)
        continue
      }
      if (line.startsWith("\\")) {
        body.push({ kind: "marker", raw: line, anchor: body.length - 1 })
        continue
      }
      if (line.startsWith("+")) {
        body.push({ kind: "add", raw: line, anchor: -1 })
        continue
      }
      if (line.startsWith("-")) {
        body.push({ kind: "del", raw: line, anchor: -1 })
        continue
      }
      if (line.startsWith(" ") || line === "") {
        body.push({ kind: "context", raw: line, anchor: -1 })
        continue
      }
      // An unrecognized body line means the patch is not the shape this expects, so leave it alone.
      throw new Error("unexpected hunk line")
    }
    flush()

    if (!sawHunk) return unchanged()
    if (keptHunks === 0 && droppedHunks > 0) return undefined
    return { patch: out.join("\n") + (endsWithNewline ? "\n" : ""), additions, deletions }
  } catch {
    return unchanged()
  }
}
