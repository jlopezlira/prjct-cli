/**
 * Find the closest registered command to a user-entered name.
 *
 * Used by:
 *   - core/index.ts → "Did you mean…" hint when an unknown command is run.
 *   - core/index.ts + core/daemon/daemon.ts → typo guard on the bare-verb
 *     auto-route to capture (a single-word near-typo of a real command
 *     should surface as "unknown" instead of being silently captured).
 *
 * Levenshtein distance ≤ 2 is the suggestion threshold — close enough to
 * catch fat-finger typos, far enough to not match unrelated short words.
 */

import { COMMANDS } from './command-data'

/**
 * Closest match across the FULL command manifest (including bin-only verbs
 * like health/crew/harness). Registry-only matching missed pure bin-only
 * names, so typos never suggested them.
 */
export function findClosestCommand(input: string): string | null {
  const needle = input.toLowerCase()
  const best = COMMANDS.reduce<{ name: string | null; distance: number }>(
    (current, command) => {
      const name = command.name
      // Length delta > threshold cannot be within edit distance 2.
      if (Math.abs(name.length - needle.length) > 2) return current
      const distance = editDistance(needle, name.toLowerCase())
      return distance < current.distance ? { name, distance } : current
    },
    { name: null, distance: Infinity }
  )
  return best.distance <= 2 ? best.name : null
}

function editDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (Math.abs(m - n) > 2) return 3
  const initial = Array.from({ length: n + 1 }, (_, index) => index)
  const final = Array.from(a).reduce((previous, charA, rowIndex) => {
    const row = [rowIndex + 1]
    for (const [columnIndex, charB] of Array.from(b).entries()) {
      row.push(
        charA === charB
          ? previous[columnIndex]!
          : 1 + Math.min(previous[columnIndex + 1]!, row[columnIndex]!, previous[columnIndex]!)
      )
    }
    return row
  }, initial)
  return final[n]!
}
