import { describe, expect, it, test } from 'bun:test'
import type { HarnessKind, HarnessLevel, HarnessRisk } from '../../schemas/state'
import { orchestrationFor } from '../../services/task-orchestration'

const h = (level: HarnessLevel, kind: HarnessKind, risk: HarnessRisk = 'medium') => ({
  level,
  kind,
  risk,
})

describe('orchestrationFor — triage drives model/effort routing', () => {
  test('H0 trivial → cheap model, low effort, DIRECT, no ceremony', () => {
    const p = orchestrationFor(h('H0', 'chore', 'low'))
    expect(p.model).toBe('fast')
    expect(p.effort).toBe('low')
    expect(p.spec).toBe('none')
    expect(p.tests).toBe('none')
    expect(p.fanout).toBe('direct')
    expect(p.directive).toContain('no subagents')
    expect(p.directive).toContain('Don’t burn frontier tokens')
    // No duplicated effort phrase.
    expect(p.directive).not.toContain('low effort, low effort')
  })

  test('H1 bug → balanced model, direct, regression test behind', () => {
    const p = orchestrationFor(h('H1', 'bug'))
    expect(p.model).toBe('balanced')
    expect(p.fanout).toBe('direct')
    expect(p.spec).toBe('none')
    expect(p.tests).toBe('after')
  })

  test('H2 feature → frontier, frame spec, tests-first, parallel fan-out DEFAULT geometry', () => {
    const p = orchestrationFor(h('H2', 'feature'))
    expect(p.model).toBe('frontier')
    expect(p.spec).toBe('frame')
    expect(p.tests).toBe('first')
    expect(p.fanout).toBe('parallel')
    expect(p.directive).toContain('DEFAULT multi-agent')
    expect(p.directive).toContain('DEFAULT geometry')
    expect(p.directive).toMatch(/one bounded quality card/i)
    expect(p.directive).not.toMatch(/review \(balanced dual-blind\)/i)
  })

  test('H3 high-risk → frontier, HIGH effort, reviewed spec, tests-first, CREW', () => {
    const p = orchestrationFor(h('H3', 'security', 'high'))
    expect(p.model).toBe('frontier')
    expect(p.effort).toBe('high')
    expect(p.spec).toBe('reviewed')
    expect(p.tests).toBe('first')
    expect(p.fanout).toBe('crew')
    expect(p.directive).toContain('crew')
    expect(p.directive).toMatch(/at most 2 reviewer agents/i)
    expect(p.directive).toContain('DEFAULT geometry')
  })

  test('weak-model mode elevates quality ceremony', () => {
    const off = orchestrationFor(h('H2', 'feature'), 'off', 'off', 'off')
    const on = orchestrationFor(h('H2', 'feature'), 'off', 'off', 'on')
    expect(off.quality).toBe('standard')
    expect(on.quality).toBe('full')
  })
})

describe('orchestrationFor — SDD/TDD modes are a FLOOR (only ADD ceremony)', () => {
  test('SDD strict forces a reviewed spec even on a simple bug', () => {
    const off = orchestrationFor(h('H1', 'bug'), 'off')
    expect(off.spec).toBe('none')
    const strict = orchestrationFor(h('H1', 'bug'), 'strict')
    expect(strict.spec).toBe('reviewed')
  })

  test('SDD advisory raises none → frame but never lowers reviewed', () => {
    expect(orchestrationFor(h('H1', 'bug'), 'advisory').spec).toBe('frame')
    // H3 already reviewed — advisory must not downgrade it.
    expect(orchestrationFor(h('H3', 'security', 'high'), 'advisory').spec).toBe('reviewed')
  })

  test('TDD strict forces tests-first; assist raises none → after', () => {
    expect(orchestrationFor(h('H1', 'bug'), 'off', 'strict').tests).toBe('first')
    expect(orchestrationFor(h('H0', 'chore', 'low'), 'off', 'assist').tests).toBe('none') // chore: no code
    expect(orchestrationFor(h('H1', 'bug'), 'off', 'assist').tests).toBe('after')
  })

  test('docs/chore NEVER get spec or tests, even under strict modes', () => {
    const docs = orchestrationFor(h('H0', 'docs', 'low'), 'strict', 'strict')
    expect(docs.spec).toBe('none')
    expect(docs.tests).toBe('none')
    expect(docs.fanout).toBe('direct')
  })
})

describe('orchestrationFor — determinism', () => {
  test('same inputs → identical plan (no LLM, no randomness)', () => {
    const a = orchestrationFor(h('H2', 'refactor'), 'advisory', 'assist')
    const b = orchestrationFor(h('H2', 'refactor'), 'advisory', 'assist')
    expect(a).toEqual(b)
  })
})

describe('research tasks fan out', () => {
  it('classifies investigation work as research → parallel', async () => {
    const { buildTaskHarness } = await import('../../services/task-harness')
    const { orchestrationFor } = await import('../../services/task-orchestration')
    const harness = buildTaskHarness('analiza este repo y compara con los 3 mejores harnesses')
    expect(harness.kind).toBe('research')
    const plan = orchestrationFor(harness)
    expect(plan.fanout).toBe('parallel')
    expect(plan.tests).toBe('none') // read-only work leaves no regression test
  })

  it('does not shadow bug/security classification', async () => {
    const { buildTaskHarness } = await import('../../services/task-harness')
    expect(buildTaskHarness('fix the broken analysis parser').kind).toBe('bug')
    expect(buildTaskHarness('security review of auth flow').kind).toBe('security')
  })
})
