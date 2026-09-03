import { afterEach, describe, expect, it } from 'bun:test'
import type { QaCriterion, QaFlow, QaPlan, QaReceipt } from '../../schemas/qa'
import {
  effectiveQaMode,
  flowVerified,
  formatQaInject,
  qaAppliesTo,
  qaDoneVerdict,
  qaNextAction,
  qaShipVerdict,
  qaWorkCue,
} from '../../services/qa-gate'
import type { LocalConfig } from '../../types/config'

const NOW = '2026-09-02T10:00:00.000Z'
const NOW_MS = Date.parse(NOW)

const config = (over: Partial<LocalConfig> = {}): LocalConfig => ({
  projectId: 'p1',
  dataPath: '/tmp/p1',
  ...over,
})

const flow = (over: Partial<QaFlow> = {}): QaFlow => ({
  id: 'fl-1',
  name: 'login works',
  kind: 'ui',
  given: [],
  when: [],
  // biome-ignore lint/suspicious/noThenProperty: GIVEN/WHEN/THEN domain language; never awaited
  then: [],
  status: 'pending',
  ...over,
})

const criterion = (over: Partial<QaCriterion> = {}): QaCriterion => ({
  id: 'ac-1',
  text: 'GET /health returns 200',
  verifiable: true,
  status: 'pending',
  ...over,
})

const plan = (over: Partial<QaPlan> = {}): QaPlan => ({
  version: 1,
  taskId: 't1',
  seededFromSpec: false,
  createdAt: NOW,
  updatedAt: NOW,
  criteria: [],
  flows: [],
  ...over,
})

const receipt = (over: Partial<QaReceipt> = {}): QaReceipt => ({
  version: 1,
  taskId: 't1',
  ranAt: NOW,
  headSha: 'abc',
  dirty: false,
  passed: true,
  vacuous: false,
  app: { started: false },
  checks: [],
  probes: [],
  ...over,
})

const httpProbe = { type: 'http' as const, method: 'GET', path: '/', expect: { bodyIncludes: [] } }

afterEach(() => {
  delete process.env.PRJCT_QA_MODE
})

describe('effectiveQaMode', () => {
  it('config wins, env is the fallback, packs gate when unset, else off', () => {
    expect(effectiveQaMode(config({ qa: { mode: 'strict' } }))).toBe('strict')
    process.env.PRJCT_QA_MODE = 'advisory'
    expect(effectiveQaMode(config())).toBe('advisory')
    delete process.env.PRJCT_QA_MODE
    expect(effectiveQaMode(config({ persona: { role: 'DEV', packs: ['code'] } }))).toBe('advisory')
    expect(effectiveQaMode(config({ persona: { role: 'DEV', packs: ['code-strict'] } }))).toBe(
      'strict'
    )
    expect(effectiveQaMode(config())).toBe('off')
    expect(effectiveQaMode(null)).toBe('off')
  })

  it('an explicit off beats the pack default', () => {
    expect(
      effectiveQaMode(config({ qa: { mode: 'off' }, persona: { role: 'DEV', packs: ['code'] } }))
    ).toBe('off')
  })
})

describe('qaAppliesTo / flowVerified', () => {
  it('never applies to H0 or mode off; unknown level applies', () => {
    expect(qaAppliesTo('H0', 'strict')).toBe(false)
    expect(qaAppliesTo('H2', 'off')).toBe(false)
    expect(qaAppliesTo(undefined, 'advisory')).toBe(true)
  })

  it('author evidence never satisfies strict', () => {
    const author = flow({ status: 'passed', verifiedBy: 'author' })
    expect(flowVerified(author, 'advisory')).toBe(true)
    expect(flowVerified(author, 'strict')).toBe(false)
    expect(flowVerified(flow({ status: 'passed', verifiedBy: 'machine' }), 'strict')).toBe(true)
    expect(flowVerified(flow({ status: 'passed', verifiedBy: 'agent' }), 'strict')).toBe(true)
    expect(flowVerified(flow({ status: 'failed', verifiedBy: 'machine' }), 'advisory')).toBe(false)
  })
})

describe('qaNextAction', () => {
  const base = {
    mode: 'strict' as const,
    harnessLevel: 'H1' as const,
    headSha: 'abc',
    nowMs: NOW_MS,
  }

  it('walks write_plan → run_probes → dispatch_qa_agent → approve', () => {
    expect(qaNextAction({ ...base, plan: null, receipt: null }).kind).toBe('write_plan')
    const withProbe = plan({ flows: [flow({ probe: httpProbe })] })
    expect(qaNextAction({ ...base, plan: withProbe, receipt: null }).kind).toBe('run_probes')
    const probed = plan({
      flows: [
        flow({ probe: httpProbe, status: 'passed', verifiedBy: 'machine' }),
        flow({ id: 'fl-2', name: 'dashboard' }),
      ],
    })
    expect(qaNextAction({ ...base, plan: probed, receipt: receipt() }).kind).toBe(
      'dispatch_qa_agent'
    )
    const done = plan({
      criteria: [criterion({ status: 'met', verifiedBy: 'agent' })],
      flows: [flow({ probe: httpProbe, status: 'passed', verifiedBy: 'machine' })],
    })
    expect(qaNextAction({ ...base, plan: done, receipt: receipt() }).kind).toBe('approve')
  })

  it('a stale receipt sends the cycle back to run_probes', () => {
    const probed = plan({
      flows: [flow({ probe: httpProbe, status: 'passed', verifiedBy: 'machine' })],
    })
    const stale = receipt({ headSha: 'other' })
    expect(qaNextAction({ ...base, plan: probed, receipt: stale }).kind).toBe('run_probes')
  })

  it('failures rank above everything else; author-only flows need the subagent under strict', () => {
    const failed = plan({ flows: [flow({ status: 'failed', evidence: 'boom' })] })
    const card = qaNextAction({ ...base, plan: failed, receipt: null })
    expect(card.kind).toBe('fix_failures')
    expect(card.steps[0]).toContain('fl-1')
    const authorOnly = plan({ flows: [flow({ status: 'passed', verifiedBy: 'author' })] })
    expect(qaNextAction({ ...base, plan: authorOnly, receipt: null }).kind).toBe(
      'dispatch_qa_agent'
    )
    expect(qaNextAction({ ...base, mode: 'advisory', plan: authorOnly, receipt: null }).kind).toBe(
      'approve'
    )
  })

  it('is idle when the phase does not apply, and the inject stays bounded', () => {
    expect(qaNextAction({ ...base, mode: 'off', plan: null, receipt: null }).kind).toBe('idle')
    expect(formatQaInject(qaNextAction({ ...base, mode: 'off', plan: null, receipt: null }))).toBe(
      null
    )
    const inject = formatQaInject(qaNextAction({ ...base, plan: null, receipt: null }))
    expect(inject).toContain('write_plan')
    expect((inject ?? '').length).toBeLessThanOrEqual(320)
  })
})

describe('qaDoneVerdict', () => {
  const base = { harnessLevel: 'H1' as const, headSha: 'abc', nowMs: NOW_MS, receipt: null }

  it('strict blocks with the unblock verb; advisory warns; off is silent', () => {
    const strict = qaDoneVerdict({ ...base, mode: 'strict', plan: null })
    expect(strict.blocked).toBe(true)
    expect(strict.message).toContain('prjct qa next')
    const advisory = qaDoneVerdict({ ...base, mode: 'advisory', plan: null })
    expect(advisory.blocked).toBe(false)
    expect(advisory.message?.startsWith('⚠')).toBe(true)
    expect(qaDoneVerdict({ ...base, mode: 'off', plan: null })).toEqual({
      blocked: false,
      message: null,
    })
    expect(qaDoneVerdict({ ...base, mode: 'strict', harnessLevel: 'H0', plan: null }).blocked).toBe(
      false
    )
  })

  it('passes once every criterion and flow is verified for this HEAD', () => {
    const done = plan({
      criteria: [criterion({ status: 'met', verifiedBy: 'agent' })],
      flows: [flow({ probe: httpProbe, status: 'passed', verifiedBy: 'machine' })],
    })
    expect(qaDoneVerdict({ ...base, mode: 'strict', plan: done, receipt: receipt() }).blocked).toBe(
      false
    )
    // Same plan, receipt bound to another HEAD → the probes verified something else.
    const verdict = qaDoneVerdict({
      ...base,
      mode: 'strict',
      plan: done,
      receipt: receipt({ headSha: 'moved' }),
    })
    expect(verdict.blocked).toBe(true)
    expect(verdict.message).toContain('stale')
  })
})

describe('qaShipVerdict', () => {
  const base = { harnessLevel: 'H1' as const, headSha: 'abc', nowMs: NOW_MS }

  it('override proceeds and says so; a RED fresh receipt blocks at every mode', () => {
    const over = qaShipVerdict({
      ...base,
      mode: 'strict',
      plan: null,
      receipt: null,
      override: true,
    })
    expect(over.blocked).toBe(false)
    expect(over.message).toContain('overridden')
    const red = receipt({
      passed: false,
      probes: [{ flowId: 'fl-1', type: 'http', ok: false, outcome: 'mismatch', durationMs: 1 }],
    })
    const advisoryRed = qaShipVerdict({
      ...base,
      mode: 'advisory',
      plan: plan({ flows: [flow({ probe: httpProbe, status: 'failed' })] }),
      receipt: red,
      override: false,
    })
    expect(advisoryRed.blocked).toBe(true)
    expect(advisoryRed.message).toContain('RED')
  })

  it('strict refuses author-only verification; advisory accepts it with a checklist', () => {
    const authorOnly = plan({ flows: [flow({ status: 'passed', verifiedBy: 'author' })] })
    const strict = qaShipVerdict({
      ...base,
      mode: 'strict',
      plan: authorOnly,
      receipt: null,
      override: false,
    })
    expect(strict.blocked).toBe(true)
    expect(strict.message).toContain('author-only')
    const advisory = qaShipVerdict({
      ...base,
      mode: 'advisory',
      plan: authorOnly,
      receipt: null,
      override: false,
    })
    expect(advisory.blocked).toBe(false)
    expect(advisory.checklist.some((l) => l.includes('login works'))).toBe(true)
  })
})

describe('qaWorkCue', () => {
  it('directs the agent to write the plan first, or to review a seeded one', () => {
    const empty = qaWorkCue({ mode: 'advisory', harnessLevel: 'H1', plan: null, seeded: false })
    expect(empty.section).toContain('prjct qa plan --json')
    expect(empty.directive).toContain('BEFORE implementing')
    const seeded = qaWorkCue({
      mode: 'advisory',
      harnessLevel: 'H2',
      plan: plan({ specId: 'spec-1234abcd', criteria: [criterion()], flows: [flow()] }),
      seeded: true,
    })
    expect(seeded.directive).toContain('seeded from spec')
    expect(qaWorkCue({ mode: 'off', harnessLevel: 'H2', plan: null, seeded: false }).section).toBe(
      null
    )
    expect(
      qaWorkCue({ mode: 'strict', harnessLevel: 'H0', plan: null, seeded: false }).section
    ).toBe(null)
  })
})
