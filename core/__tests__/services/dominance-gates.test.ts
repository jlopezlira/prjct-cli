/**
 * Dominance gates vs gentle-ai / open-GSD — unit pins for discuss-lock,
 * context pressure, nyquist-lite, package legitimacy (pure logic).
 */

import { describe, expect, it } from 'bun:test'
import { contextPressureVerdict } from '../../services/context-pressure'
import { discussLockVerdict } from '../../services/discuss-lock'
import { assessAcceptanceCriteria, isVerifiableAcceptance } from '../../services/nyquist-lite'
import { buildTaskHarness } from '../../services/task-harness'

describe('discuss-lock (GSD discuss-before-plan, code-enforced)', () => {
  it('never blocks when sdd is off', () => {
    const v = discussLockVerdict({
      sddMode: 'off',
      harnessLevel: 'H3',
      hasSpecId: false,
    })
    expect(v.blocked).toBe(false)
  })

  it('blocks H2 under advisory without a reviewed spec', () => {
    const v = discussLockVerdict({
      sddMode: 'advisory',
      harnessLevel: 'H2',
      hasSpecId: false,
    })
    expect(v.blocked).toBe(true)
    expect(v.reason).toBe('discuss-h2')
    expect(v.message).toMatch(/Discuss-lock/i)
  })

  it('does not block H1 under advisory without spec', () => {
    const v = discussLockVerdict({
      sddMode: 'advisory',
      harnessLevel: 'H1',
      hasSpecId: false,
    })
    expect(v.blocked).toBe(false)
  })

  it('blocks draft specs under strict', () => {
    const v = discussLockVerdict({
      sddMode: 'strict',
      harnessLevel: 'H0',
      hasSpecId: true,
      specStatus: 'draft',
    })
    expect(v.blocked).toBe(true)
    expect(v.message).toMatch(/draft/i)
  })

  it('allows reviewed spec under H2 advisory', () => {
    const v = discussLockVerdict({
      sddMode: 'advisory',
      harnessLevel: 'H2',
      hasSpecId: true,
      specStatus: 'reviewed',
    })
    expect(v.blocked).toBe(false)
  })
})

describe('context-pressure reports MEASURED tokens, never a turn count', () => {
  // This used to derive "context density" from turns/maxTurnsPerCycle: on turn
  // 9 of 15 it announced "context density (~60%)" and told the model to stop
  // searching the codebase, while the real window might be 3% full.
  it('stays ok on turn count alone, however many turns', () => {
    for (const turnCount of [6, 8, 14, 40, 200]) {
      const v = contextPressureVerdict(
        { maxTurnsPerCycle: 10 } as never,
        { turnCount, description: 'x' } as never
      )
      expect(v.level).toBe('ok')
      expect(v.cue).toBeNull()
    }
  })

  it('stays ok when no token budget is configured — nothing is measured', () => {
    const v = contextPressureVerdict(
      {} as never,
      { turnCount: 50, tokensIn: 900_000, tokensOut: 100_000, description: 'x' } as never
    )
    expect(v.level).toBe('ok')
    expect(v.cue).toBeNull()
  })

  it('warns at 60% of the configured TOKEN budget', () => {
    const v = contextPressureVerdict(
      { maxTokensPerCycle: 100_000 } as never,
      { turnCount: 2, tokensIn: 50_000, tokensOut: 15_000, description: 'x' } as never
    )
    expect(v.level).toBe('warn')
    expect(v.cue).toContain('token budget')
    expect(v.cue).toContain('65%')
  })

  it('is critical at 80% of the token budget and still never forbids reading code', () => {
    const v = contextPressureVerdict(
      { maxTokensPerCycle: 100_000 } as never,
      { turnCount: 2, tokensIn: 80_000, tokensOut: 5_000, description: 'x' } as never
    )
    expect(v.level).toBe('critical')
    for (const banned of [
      'do not re-index',
      'no broad Grep',
      'no re-research',
      'high-signal tools only',
      'context density',
    ]) {
      expect(v.cue?.toLowerCase()).not.toContain(banned.toLowerCase())
    }
    expect(v.cue).toMatch(/Read whatever the work actually requires/i)
  })
})

describe('harness false-positives (discuss-lock dust)', () => {
  it('does not classify split-home smoke as H2 refactor', () => {
    const h = buildTaskHarness('split-home smoke')
    expect(h.kind).not.toBe('refactor')
    expect(h.level === 'H0' || h.level === 'H1').toBe(true)
  })

  it('still classifies real split refactors', () => {
    const h = buildTaskHarness('split the billing module into packages')
    expect(h.kind).toBe('refactor')
  })
})

describe('precision judgment ship gate (gentle-ai 4R v2 — with teeth)', () => {
  it('code-strict + full intensity hard-blocks without ledger', async () => {
    const { judgmentShipVerdict } = await import('../../services/precision-judgment')
    const v = judgmentShipVerdict({
      codeStrict: true,
      intensity: 'full',
      ledger: null,
      override: false,
    })
    expect(v.blocked).toBe(true)
    expect(v.mode).toBe('hard')
  })

  it('fail-closed missing refute votes stand (not silent kill)', async () => {
    const { resolveRefuteVotes } = await import('../../services/precision-judgment')
    expect(resolveRefuteVotes([], 3)).toBe('stands')
  })
})

describe('nyquist-lite (verifiable ACs)', () => {
  it('accepts test-named criteria', () => {
    expect(isVerifiableAcceptance('bun test core/foo.test.ts passes')).toBe(true)
    expect(isVerifiableAcceptance('curl returns 200 on /health')).toBe(true)
  })

  it('rejects vague prose', () => {
    expect(isVerifiableAcceptance('auth feels solid')).toBe(false)
  })

  it('reports vague list', () => {
    const r = assessAcceptanceCriteria(['user can log in', 'bun test core/auth.test.ts is green'])
    expect(r.ok).toBe(false)
    expect(r.vague.length).toBe(1)
    expect(r.verifiable).toBe(1)
  })
})
