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

export function clipResultStats(text: string, limit = MAX_RESULT_CHARS): { text: string; dropped: number } {
  // A slice end at or below zero counts from the tail, which would keep more than the limit.
  if (limit <= 0) return { text: "", dropped: text.length }
  if (text.length <= limit) return { text, dropped: 0 }
  const marker = (dropped: number) => `\n… ${dropped} chars dropped (result over ${limit}); read the diff and files for evidence\n`
  // The real dropped count is at most the full length, so sizing the marker for text.length only over-reserves.
  const budget = limit - marker(text.length).length
  if (budget <= 0) {
    const clipped = clipHead(text, limit)
    return { text: clipped, dropped: text.length - clipped.length }
  }
  const headBudget = Math.floor(budget * 0.7)
  const head = clipHead(text, headBudget)
  const tail = clipTail(text, budget - headBudget)
  const dropped = text.length - head.length - tail.length
  return { text: head + marker(dropped) + tail, dropped }
}
