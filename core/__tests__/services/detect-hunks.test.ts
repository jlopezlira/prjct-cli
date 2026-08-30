import { describe, expect, it } from 'bun:test'
import { parseChangedLinesFromUnifiedDiff } from '../../services/detect-changes'

describe('parseChangedLinesFromUnifiedDiff', () => {
  it('maps addition lines to new-file line numbers', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -10,0 +11,2 @@',
      '+export function foo() {}',
      '+export function bar() {}',
    ].join('\n')
    const map = parseChangedLinesFromUnifiedDiff(diff)
    expect(map.has('a.ts')).toBe(true)
    const lines = map.get('a.ts')!
    expect(lines.has(11)).toBe(true)
    expect(lines.has(12)).toBe(true)
  })

  it('records a deletion-only file with an empty set, not a missing entry', () => {
    // The distinction carries the risk cap: an empty set means "read the
    // hunks, nothing was added", while a missing entry means "no diff data".
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -10,3 +9,0 @@',
      '-export function gone() {}',
      '-',
      '-// trailing',
    ].join('\n')
    const map = parseChangedLinesFromUnifiedDiff(diff)
    expect(map.has('a.ts')).toBe(true)
    expect(map.get('a.ts')!.size).toBe(0)
  })

  it('leaves a file with no diff entry absent from the map', () => {
    const map = parseChangedLinesFromUnifiedDiff('')
    expect(map.has('a.ts')).toBe(false)
    expect(map.get('a.ts')).toBeUndefined()
  })
})
