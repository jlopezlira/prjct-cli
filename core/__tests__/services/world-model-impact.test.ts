import { describe, expect, test } from 'bun:test'
import { breakImpact, formatImpactMd } from '../../services/world-model-impact'

describe('breakImpact', () => {
  test('empty seeds → empty line, no throw', () => {
    const imp = breakImpact('00000000-0000-0000-0000-000000000000', [])
    expect(imp.seeds).toEqual([])
    expect(imp.line).toContain('no seed')
    expect(formatImpactMd(imp)).toBe('')
  })

  test('seeds with cold indexes still return shape', () => {
    const imp = breakImpact('00000000-0000-0000-0000-000000000000', ['core/hooks/pre-edit.ts'])
    expect(imp.seeds).toHaveLength(1)
    expect(imp.line).toContain('World model impact')
    expect(imp.hasIndexes).toBeDefined()
  })

  test('traps:false skips the memory sweep but keeps neighbours/shape', () => {
    const imp = breakImpact('00000000-0000-0000-0000-000000000000', ['core/hooks/pre-edit.ts'], 6, {
      traps: false,
    })
    expect(imp.traps).toEqual([])
    expect(imp.line).toContain('traps=0')
  })
})
