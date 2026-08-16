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
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed
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
