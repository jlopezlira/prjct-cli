/**
 * Small text-summarization helpers shared by the synthesized-markdown MCP
 * tool bodies (prjct_developer, prjct_signals) — rescued from the retired
 * wiki builders (WS-A) since these are pure text functions, not vault I/O.
 */

/** Truncate to at most `max` chars, appending an ellipsis when shortened.
 *  The result (including the ellipsis) never exceeds `max`. Whitespace
 *  (including newlines) is collapsed to single spaces first so callers get
 *  a clean single-line summary regardless of source formatting. */
export function truncate(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  return collapsed.length > max ? clipToBoundary(collapsed, max) : collapsed
}

/**
 * Clip to a whole clause, never mid-word.
 *
 * A hard `slice(0, max - 1)` cut every fragment at a character boundary, and
 * `land-synthesis` builds the session hand-off out of these — so the sentence
 * `prjct prime` shows at the start of the next session routinely stopped in
 * the middle of the operative clause. Prefer the last sentence end, else the
 * last word boundary; fall back to a hard cut only when neither leaves a
 * useful amount of text.
 */
export function clipToBoundary(text: string, max: number): string {
  if (text.length <= max) return text
  const head = clipHead(text, max - 1)
  return head.endsWith('.') || head.endsWith(';') ? head : `${head}…`
}

/**
 * Longest prefix of `text` within `max` that ends on a clause or word
 * boundary, never inside a word or a surrogate pair.
 *
 * deepseek's pruner is byte/code-point budgeted and its own docs accept that a
 * cut "can split a multi-code-point grapheme cluster". We can do strictly
 * better for free: the budget is a ceiling, not a target, so spending a few
 * characters to land on a boundary costs nothing and keeps the text readable.
 */
export function clipHead(text: string, max: number): string {
  if (text.length <= max) return text
  const window = text.slice(0, endOnCodePoint(text, max))
  const sentenceEnd = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('; '),
    window.lastIndexOf('! '),
    window.lastIndexOf('? ')
  )
  if (sentenceEnd > max * 0.5) return window.slice(0, sentenceEnd + 1)
  const wordEnd = window.lastIndexOf(' ')
  return (wordEnd > max * 0.5 ? window.slice(0, wordEnd) : window).trimEnd()
}

/**
 * Longest suffix of `text` within `max` that STARTS on a word boundary. A
 * tail that opens mid-word ("he queue") reads as corruption, which is the
 * whole reason for keeping a tail at all.
 */
export function clipTail(text: string, max: number): string {
  if (text.length <= max) return text
  const raw = text.slice(startOnCodePoint(text, text.length - max))
  const wordStart = raw.indexOf(' ')
  // Only skip to the next word when that leaves most of the budget intact.
  return (wordStart >= 0 && wordStart < max * 0.5 ? raw.slice(wordStart + 1) : raw).trimStart()
}

/** Back off one unit when the cut would leave a lone high surrogate. */
function endOnCodePoint(text: string, end: number): number {
  const at = Math.max(0, Math.min(end, text.length))
  const last = text.charCodeAt(at - 1)
  return last >= 0xd800 && last <= 0xdbff ? Math.max(0, at - 1) : at
}

/** Move forward one unit when the cut would start on a lone low surrogate. */
function startOnCodePoint(text: string, start: number): number {
  const at = Math.max(0, Math.min(start, text.length))
  const first = text.charCodeAt(at)
  return first >= 0xdc00 && first <= 0xdfff ? Math.min(text.length, at + 1) : at
}

/**
 * Display helper for friction-detector lessons.
 *
 * New detector output is structured:
 *   [category] Lesson: ...
 *   Next action: ...
 *
 * Older rows started with:
 *   [category] User pushback: "..."
 *
 * Keep both readable so existing SQLite rows do not need migration.
 */
export function summarizeFrictionLesson(content: string, max = 220): string {
  const compact = (line: string) => line.replace(/\s+/g, ' ').trim()
  const lines = content.split('\n').map(compact).filter(Boolean)

  const first = lines[0] ?? compact(content)
  const lesson = first.match(/^\[[^\]]+\]\s+Lesson:\s*(.+)$/i)?.[1]
  if (!lesson) return truncate(first, max)

  const nextAction = lines
    .find((line) => /^Next action:\s*/i.test(line))
    ?.replace(/^Next action:\s*/i, '')

  const summary = nextAction ? `${lesson} Next: ${nextAction}` : lesson
  return truncate(summary, max)
}
