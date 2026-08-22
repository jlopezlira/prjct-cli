/**
 * Alignment card — unified mid-cycle constitutional checks.
 */

import { describe, expect, it } from 'bun:test'
import { alignmentCardSummary, buildAlignmentCard } from '../../services/alignment-card'

describe('buildAlignmentCard', () => {
  it('returns ok with null markdown when no signals', () => {
    const card = buildAlignmentCard({})
    expect(card.level).toBe('ok')
    expect(card.markdown).toBeNull()
    expect(card.cues).toEqual([])
  })

  it('hard level on loop stop', () => {
    const card = buildAlignmentCard({
      loop: {
        stopped: true,
        turns: 20,
        limit: 15,
        message: '⛔ prjct hard stop: 20 turns on cycle "x" (limit 15).',
      },
    })
    expect(card.level).toBe('hard')
    expect(card.cues).toContain('loop-hard-stop')
    expect(card.markdown).toMatch(/alignment \(MUST/)
    expect(card.markdown).toMatch(/hard stop/)
  })

  it('hard level on critical context pressure', () => {
    const card = buildAlignmentCard({
      pressure: {
        level: 'critical',
        turns: 12,
        limit: 15,
        ratio: 0.85,
        limitSource: 'configured',
        cue: '# prjct: CONTEXT PRESSURE (critical ~85%) — HARD GATE\nSession is full.',
      },
    })
    expect(card.level).toBe('hard')
    expect(card.cues).toContain('context-pressure-critical')
    expect(card.markdown).toMatch(/CONTEXT PRESSURE/)
  })

  it('hard level on warn context pressure (compact path mandatory at ≥60%)', () => {
    const card = buildAlignmentCard({
      pressure: {
        level: 'warn',
        turns: 9,
        limit: 15,
        ratio: 0.6,
        limitSource: 'configured',
        cue: '# prjct: context pressure (~60%) — compact path\nMandatory close plan.',
      },
    })
    expect(card.level).toBe('hard')
    expect(card.cues).toContain('context-pressure-warn')
    expect(card.markdown).toMatch(/compact path|land/)
  })

  it('warn on stuck turns without hard loop', () => {
    const card = buildAlignmentCard({
      turns: 16,
      stuckThreshold: 15,
      loop: { stopped: false, turns: 16, limit: 0, message: '' },
    })
    expect(card.level).toBe('warn')
    expect(card.cues).toContain('stuck-cycle')
    expect(card.markdown).toMatch(/16 turns/)
  })

  // A block that already carries its own `# prjct:` header must NOT get an
  // outer "alignment" header stacked on top: that rendered a heading with
  // nothing under it, on every turn.
  it('includes quality inject without stacking an empty header on top', () => {
    const card = buildAlignmentCard({
      qualityInject: '# prjct: quality orchestrator\n- **kind**: `dispatch_reviewers`',
    })
    expect(card.cues).toContain('quality-ledger')
    expect(card.markdown).toMatch(/quality orchestrator/)
    expect(card.markdown).not.toMatch(/# prjct: alignment/)
    expect(card.markdown?.trimStart().startsWith('# prjct: quality orchestrator')).toBe(true)
  })

  it('still adds the alignment header when the blocks bring none', () => {
    const card = buildAlignmentCard({
      loop: { stopped: true, message: '⛔ prjct hard stop: 20 turns' } as never,
    })
    expect(card.markdown).toMatch(/# prjct: alignment/)
    expect(card.markdown).toMatch(/hard stop/)
  })

  it('combines loop + quality without dropping either', () => {
    const card = buildAlignmentCard({
      loop: {
        stopped: true,
        turns: 30,
        limit: 20,
        message: '⛔ hard stop loop',
      },
      qualityInject: 'quality next: merge judges',
    })
    expect(card.level).toBe('hard')
    expect(card.cues).toContain('loop-hard-stop')
    expect(card.cues).toContain('quality-ledger')
    expect(card.markdown).toMatch(/hard stop loop/)
    expect(card.markdown).toMatch(/quality next/)
  })
})

describe('alignmentCardSummary', () => {
  it('null when ok', () => {
    expect(alignmentCardSummary(buildAlignmentCard({}))).toBeNull()
  })

  it('summarizes non-ok', () => {
    const s = alignmentCardSummary(
      buildAlignmentCard({
        turns: 20,
        stuckThreshold: 15,
      })
    )
    expect(s).toMatch(/alignment:warn/)
    expect(s).toMatch(/stuck-cycle/)
  })
})
