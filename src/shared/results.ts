export const MAX_RESULT_CHARS = 4_000

// The worker return contract puts TASK and FILES at the top and BLOCKED and RISK at the bottom, so both ends survive.
function clipHead(text: string, budget: number): string {
  let cut = Math.min(budget, text.length)
  const newline = text.lastIndexOf("\n", cut - 1)
  if (newline > 0) cut = newline
  if (cut > 0 && cut < text.length) {
    const low = text.charCodeAt(cut - 1)
    if (low >= 0xd800 && low <= 0xdbff) cut -= 1
  }
  return text.slice(0, cut)
}

function clipTail(text: string, budget: number): string {
  let start = Math.max(0, text.length - budget)
  const newline = text.indexOf("\n", start)
  if (newline >= 0) start = newline + 1
  if (start < text.length) {
    const low = text.charCodeAt(start)
    if (low >= 0xdc00 && low <= 0xdfff) start += 1
  }
  return text.slice(start)
}

export type ClipOptions = {
  headRatio?: number
  marker?: (dropped: number) => string
}

export function clipResultStats(text: string, limit = MAX_RESULT_CHARS, options: ClipOptions = {}): { text: string; dropped: number } {
  // A slice end at or below zero counts from the tail, which would keep more than the limit.
  if (limit <= 0) return { text: "", dropped: text.length }
  if (text.length <= limit) return { text, dropped: 0 }
  const marker = options.marker ?? ((dropped: number) => `\n… ${dropped} chars dropped (result over ${limit}); read the diff and files for evidence\n`)
  // The real dropped count is at most the full length, so sizing the marker for text.length only over-reserves.
  const budget = limit - marker(text.length).length
  if (budget <= 0) {
    const clipped = clipHead(text, limit)
    return { text: clipped, dropped: text.length - clipped.length }
  }
  // Clamped so a caller cannot push the head past the budget and hand clipTail a negative one.
  const headRatio = Math.min(1, Math.max(0, options.headRatio ?? 0.7))
  const headBudget = Math.floor(budget * headRatio)
  const head = clipHead(text, headBudget)
  const tail = clipTail(text, budget - headBudget)
  const dropped = text.length - head.length - tail.length
  return { text: head + marker(dropped) + tail, dropped }
}

// Order matters: a terminated OSC/DCS/APC sequence can itself contain CSI-looking bytes,
// so strip the multi-character sequences first, then bare CSI, then C0, then bidi and format controls.
// Spelled with control escapes and unicode sets so every byte of this function stays visible:
// \c[ is ESC, \cG is BEL, \cI and \cJ are tab and newline, and the v-mode class is Cc minus tab and newline.
function stripShellNoise(text: string): string {
  return text
    .replace(/\][^]*(?:|\\])/g, "")
    .replace(/[P^_][\s\S]*?\\]/g, "")
    .replace(/\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\p{Cc}&&[^\cI\cJ]]/gv, "")
    .replace(/\p{Cf}/gu, "")
}

// Shell failures and test summaries sit at the tail, so shell output keeps the smaller head share.
// labelLimit names the overall cap in the marker when a caller clips against a smaller remaining budget.
export function clipShellOutput(text: string, limit = 8_000, labelLimit = limit): { text: string; dropped: number } {
  const clean = stripShellNoise(text)
  // Escape codes the model never needed count as dropped, but they never reach the marker's arithmetic.
  const stripped = text.length - clean.length
  const clipped = clipResultStats(clean, limit, {
    headRatio: 0.3,
    marker: (dropped) => `\n… ${dropped} chars dropped (shell output over ${labelLimit})\n`,
  })
  return { text: clipped.text, dropped: clipped.dropped + stripped }
}

export type ShellPart = { readonly type: string; readonly text?: string }

// A shell result can be split into parts, so the cap is shared: one 8000-char budget across every text part.
export function clipShellParts<P extends ShellPart>(parts: ReadonlyArray<P>, limit = 8_000): { parts: P[]; dropped: number } {
  let remaining = limit
  let before = 0
  let after = 0
  const clippedParts = parts.map((part) => {
    if (part.type !== "text" || typeof part.text !== "string") return part
    before += part.text.length
    const text = remaining <= 0 ? "" : clipShellOutput(part.text, Math.min(remaining, part.text.length), limit).text
    remaining -= text.length
    after += text.length
    if (text === part.text) return part
    // The copy keeps every field of the host part; only the text changes, so it stays the same part type.
    return { ...part, text } as P
  })
  return { parts: clippedParts, dropped: before - after }
}

// Zero-width and format characters can hide a decision or a credential from a line test,
// so the guards read a copy with them removed while the report itself is untouched.
const HIDDEN_FORMAT = /\p{Cf}/gu

function visibleForGuards(text: string): string {
  return text.replace(HIDDEN_FORMAT, "")
}

// A real decision or a credential can sit in the middle a head-and-tail clip drops, so those reports stay whole.
// The whitespace lives inside the lookahead: a \s* before it would backtrack to zero and let "BLOCKED: nothing" through.
const UNCLIPPABLE = /^\s*(?:BLOCKED|RISK|NOT DONE):(?!\s*(?:nothing|none)\b)/im
const SECRET = /-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_-]?key|secret|password|token)\s*[:=]\s*\S{8,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|Bearer\s+\S{8,}/i

export function clipSubagentReport(text: string, limit = 2_500): { text: string; dropped: number } {
  const visible = visibleForGuards(text)
  if (UNCLIPPABLE.test(visible) || SECRET.test(visible)) return { text, dropped: 0 }
  return clipResultStats(text, limit, {
    marker: (dropped) => `\n… ${dropped} chars dropped (subagent report over ${limit}; the child session holds the full text)\n`,
  })
}

// Gating on the child session and state, not the tag shape, keeps a quoted or spoofed report out of the clip.
function isSubagentReport(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed.startsWith('<subagent sessionID="ses_')) return false
  const open = trimmed.indexOf(">")
  if (open < 0) return false
  if (!/\bstate="(?:completed|error|cancelled)"/.test(trimmed.slice(0, open))) return false
  return trimmed.endsWith("</subagent>")
}

// The host Message is a schema class with readonly fields, so clipping reads it through a narrow structural view.
export type ClipPart = { readonly type: string; readonly text?: string | null }
export type ClipMessage = { readonly role: string; readonly content: ReadonlyArray<ClipPart> }

export function clipSubagentReports<M extends ClipMessage>(messages: M[], limit = 2_500): { messages: M[]; clipped: number } {
  const next: M[] = []
  let clipped = 0
  for (const message of messages) {
    const parts = message.content
    // Only the host's own user-role completion notice is a report; a report is exactly one text part.
    if (message.role !== "user" || parts.length !== 1) {
      next.push(message)
      continue
    }
    const part = parts[0]
    if (part.type !== "text" || typeof part.text !== "string" || !isSubagentReport(part.text)) {
      next.push(message)
      continue
    }
    const result = clipSubagentReport(part.text, limit)
    // Clipped text is under the limit, so a second pass returns it unchanged.
    if (result.text === part.text) {
      next.push(message)
      continue
    }
    // Copy rather than writing into the host's session history. Object.create keeps the host
    // Message prototype so the copy stays an instanceof the host class with the same own keys.
    const copy = Object.assign(Object.create(Object.getPrototypeOf(message)), message, {
      content: [{ ...part, text: result.text }] as unknown as M["content"],
    }) as M
    next.push(copy)
    clipped += 1
  }
  // Returning the input array when nothing changed keeps a repeated pass free of allocation and identity churn.
  return { messages: clipped === 0 ? messages : next, clipped }
}
