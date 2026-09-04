import { describe, expect, it } from 'bun:test'
import {
  isSessionRolloverSafeCommand,
  sessionRolloverLimit,
  sessionRolloverVerdict,
} from '../../services/session-rollover'

describe('session rollover policy', () => {
  const config = { maxTurnsPerSession: 100 }

  it('stays silent before 80% and warns with stable bytes at 80%', () => {
    expect(sessionRolloverVerdict(config, 79)).toMatchObject({ level: 'ok', cue: null })

    const first = sessionRolloverVerdict(config, 80)
    const later = sessionRolloverVerdict(config, 99)
    expect(first.level).toBe('warn')
    expect(first.cue).toBe(later.cue)
    expect(first.cue).toContain('80%')
    expect(first.cue).toContain('100-turn limit')
  })

  it('requires a fresh non-resumed session at the configured limit', () => {
    const verdict = sessionRolloverVerdict(config, 100)
    expect(verdict.stopped).toBe(true)
    expect(verdict.cue).toContain('SESSION ROLLOVER REQUIRED')
    expect(verdict.cue).toContain('prjct land --md')
    expect(verdict.cue).toContain('do not resume')
    expect(verdict.cue).toContain('prjct prime --md')
  })

  it('is disabled without a positive project limit', () => {
    expect(sessionRolloverVerdict({}, 10_000)).toMatchObject({
      level: 'ok',
      stopped: false,
      cue: null,
    })
  })

  it('defaults code packs to 100 turns and honors an explicit zero override', () => {
    expect(sessionRolloverLimit({ persona: { role: 'DEV', packs: ['code'] } })).toBe(100)
    expect(sessionRolloverVerdict({ persona: { role: 'DEV', packs: ['code'] } }, 100).stopped).toBe(
      true
    )
    expect(
      sessionRolloverVerdict(
        { persona: { role: 'DEV', packs: ['code-strict'] }, maxTurnsPerSession: 0 },
        1000
      ).stopped
    ).toBe(false)
  })

  it('allows only the exact continuity command after the hard stop', () => {
    expect(isSessionRolloverSafeCommand('prjct land')).toBe(true)
    expect(isSessionRolloverSafeCommand('  prjct land --md  ')).toBe(true)
    expect(isSessionRolloverSafeCommand('prjct land --md && git push')).toBe(false)
    expect(isSessionRolloverSafeCommand('git status')).toBe(false)
  })
})
