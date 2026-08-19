/**
 * Session Context Cache — prjct's own "prompt cache" for non-caching hosts.
 * Pins: (1) the delivered-content ledger collapses repeats and honors
 * full=true; (2) state normalization treats per-turn counter noise as
 * immaterial while keeping deliberate signals material.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import {
  _resetDeliveredLedgerForTests,
  condenseDelivered,
  normalizeStateForMaterialChange,
} from '../../services/session-context-cache'

beforeEach(() => {
  _resetDeliveredLedgerForTests()
})

describe('condenseDelivered (MCP delivered-content ledger)', () => {
  const entries = [
    { id: 'mem_1', content: 'auth tokens rotate hourly' },
    { id: 'mem_2', content: 'session cache expires in 15m' },
  ]

  it('first delivery is fresh; verbatim re-delivery collapses to repeats', () => {
    const first = condenseDelivered('mem:p1', entries)
    expect(first.fresh.length).toBe(2)
    expect(first.repeats.length).toBe(0)

    const second = condenseDelivered('mem:p1', entries)
    expect(second.fresh.length).toBe(0)
    expect(second.repeats.map((e) => e.id)).toEqual(['mem_1', 'mem_2'])
  })

  it('changed content re-delivers in full (hash mismatch = fresh)', () => {
    condenseDelivered('mem:p1', entries)
    const updated = [{ id: 'mem_1', content: 'auth tokens rotate daily now' }]
    const result = condenseDelivered('mem:p1', updated)
    expect(result.fresh.map((e) => e.id)).toEqual(['mem_1'])
  })

  it('full=true bypasses the ledger for compacted-away contexts', () => {
    condenseDelivered('mem:p1', entries)
    const forced = condenseDelivered('mem:p1', entries, { full: true })
    expect(forced.fresh.length).toBe(2)
  })

  it('scopes are independent — delivery in one project never hides another', () => {
    condenseDelivered('mem:p1', entries)
    const other = condenseDelivered('mem:p2', entries)
    expect(other.fresh.length).toBe(2)
  })
})

describe('normalizeStateForMaterialChange', () => {
  it('per-edit and per-turn counters are immaterial', () => {
    const a = [
      '- Branch: main — working tree 3 modified, 2 untracked, 1 unpushed',
      '  ↳ Turn 10 on this cycle — still advancing the goal?',
      '⚠ 16 turns on this cycle and it is still open.',
      '# prjct: context density (~82%)',
      '  ↳ Token budget: 1,200 of 50,000 (2%).',
    ].join('\n')
    const b = a
      .replace('3 modified, 2 untracked', '5 modified, 4 untracked')
      .replace('Turn 10', 'Turn 20')
      .replace('16 turns', '17 turns')
      .replace('~82%', '~91%')
      .replace('1,200 of 50,000 (2%)', '9,000 of 50,000 (18%)')
    expect(normalizeStateForMaterialChange(a)).toBe(normalizeStateForMaterialChange(b))
  })

  it('unpushed commits appearing on a dirty tree stay material', () => {
    const dirty = '- Branch: main — working tree 3 modified, 2 untracked'
    const dirtyUnpushed = '- Branch: main — working tree 1 modified, 4 unpushed'
    const dirtyUnpushedMore = '- Branch: main — working tree 5 modified, 9 untracked, 7 unpushed'
    expect(normalizeStateForMaterialChange(dirty)).not.toBe(
      normalizeStateForMaterialChange(dirtyUnpushed)
    )
    expect(normalizeStateForMaterialChange(dirtyUnpushed)).toBe(
      normalizeStateForMaterialChange(dirtyUnpushedMore)
    )
  })

  it('branch switches and appearing cues stay material', () => {
    const base = '- Branch: main — working tree 3 modified'
    const branched = '- Branch: feat/x — working tree 3 modified'
    expect(normalizeStateForMaterialChange(base)).not.toBe(
      normalizeStateForMaterialChange(branched)
    )
    const withCue = `${base}\n  ↳ Turn 10 on this cycle — still advancing the goal?`
    expect(normalizeStateForMaterialChange(base)).not.toBe(normalizeStateForMaterialChange(withCue))
  })
})
