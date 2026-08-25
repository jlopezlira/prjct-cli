import { describe, expect, it } from 'bun:test'
import { rrfFuse } from '../../memory/rank-fusion'

describe('rrfFuse', () => {
  it('ranks an entry both legs agree on above either leg’s lone favourite', () => {
    // `both` is #2 on each side; `lexOnly` and `semOnly` are #1 on one side only.
    // This is the property the old prepend-semantic behavior violated.
    const fused = rrfFuse([
      ['lexOnly', 'both'],
      ['semOnly', 'both'],
    ])
    expect(fused[0]).toBe('both')
    expect(fused).toContain('lexOnly')
    expect(fused).toContain('semOnly')
  })

  it('keeps a unanimous #1 on top', () => {
    expect(
      rrfFuse([
        ['a', 'b', 'c'],
        ['a', 'c', 'b'],
      ])[0]
    ).toBe('a')
  })

  it('breaks score ties by first-seen order, so the first list wins', () => {
    // Same rank in isolated lists → identical scores; the earlier list decides.
    expect(rrfFuse([['x'], ['y']])).toEqual(['x', 'y'])
  })

  it('is a no-op shape for a single list and tolerates empties', () => {
    expect(rrfFuse([['a', 'b']])).toEqual(['a', 'b'])
    expect(rrfFuse([[], ['a']])).toEqual(['a'])
    expect(rrfFuse([])).toEqual([])
  })

  it('dedupes ids that appear in both lists', () => {
    const fused = rrfFuse([
      ['a', 'b'],
      ['b', 'a'],
    ])
    expect(fused.length).toBe(2)
    expect(new Set(fused)).toEqual(new Set(['a', 'b']))
  })
})
