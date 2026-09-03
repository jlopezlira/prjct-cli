import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { qaId } from '../../schemas/qa'
import {
  applyQaReport,
  getQaPlan,
  markFlow,
  qaPlanSummary,
  renderQaChecklistMd,
  saveSeededPlan,
  seedQaPlanFromSpec,
  upsertQaPlan,
} from '../../services/qa-plan'
import prjctDb from '../../storage/database'
import { type Spec, SpecContentSchema } from '../../types/spec'
import { patchPathManager, restorePathManager } from '../_setup/path-manager-mock'

const fixture: { tmpRoot: string; projectId: string } = { tmpRoot: '', projectId: '' }

beforeEach(async () => {
  fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-qa-plan-'))
  fixture.projectId = `qa-plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  patchPathManager(fixture.tmpRoot)
  prjctDb.run(fixture.projectId, 'SELECT 1 WHERE 1=0')
})

afterEach(async () => {
  restorePathManager()
  await fs.rm(fixture.tmpRoot, { recursive: true, force: true }).catch(() => undefined)
})

function spec(): Spec {
  return {
    id: 'spec-abc12345',
    title: 'Login',
    status: 'reviewed',
    content: SpecContentSchema.parse({
      goal: 'Users can log in',
      acceptance_criteria: [
        'POST /login returns 200 and a session cookie — curl test',
        'the dashboard shows the user name',
      ],
      test_plan: ['open /login in a browser and submit valid credentials'],
      scenarios: {
        login: [
          {
            name: 'valid credentials',
            given: ['a registered user'],
            when: ['they submit the form'],
            // biome-ignore lint/suspicious/noThenProperty: GIVEN/WHEN/THEN domain language; never awaited
            then: ['they land on /dashboard'],
          },
        ],
      },
    }),
    tags: {},
    createdAt: 'x',
    updatedAt: 'x',
    shippedAt: null,
    shippedPr: null,
    shippedSha: null,
    archivedAt: null,
  }
}

const EVIDENCE = 'Observed at http://localhost:3000/dashboard: header shows "Hi Ana" after submit.'

describe('seedQaPlanFromSpec', () => {
  it('materializes criteria, scenario flows and manual flows with stable ids', () => {
    const plan = seedQaPlanFromSpec(spec(), 't1', 'main')
    expect(plan.seededFromSpec).toBe(true)
    expect(plan.specId).toBe('spec-abc12345')
    expect(plan.criteria.map((c) => c.verifiable)).toEqual([true, false])
    expect(plan.criteria[0]?.id).toBe(
      qaId('ac', 'POST /login returns 200 and a session cookie — curl test')
    )
    expect(plan.flows.map((f) => f.kind)).toEqual(['ui', 'manual'])
    expect(plan.flows[0]?.name).toBe('login: valid credentials')
    expect(plan.flows[0]?.then).toEqual(['they land on /dashboard'])
    // Same spec ⇒ same ids on every machine.
    expect(seedQaPlanFromSpec(spec(), 't1').flows[0]?.id).toBe(plan.flows[0]?.id)
  })

  it('persists and reads back through the kv doc', () => {
    const saved = saveSeededPlan(fixture.projectId, seedQaPlanFromSpec(spec(), 't1'))
    expect(getQaPlan(fixture.projectId, 't1')?.flows.length).toBe(saved.flows.length)
    expect(getQaPlan(fixture.projectId, 'nope')).toBe(null)
  })
})

describe('upsertQaPlan', () => {
  it('merges by id and keeps statuses the input does not mention', () => {
    const first = upsertQaPlan(
      fixture.projectId,
      't1',
      {
        criteria: ['GET /health returns 200 — http probe'],
        flows: [{ name: 'health ok', kind: 'api', probe: { type: 'http', path: '/health' } }],
      },
      { mode: 'advisory' }
    )
    expect(first.plan?.flows[0]?.probe?.type).toBe('http')
    const flowId = first.plan?.flows[0]?.id ?? ''
    markFlow(fixture.projectId, 't1', flowId, { status: 'passed', verifiedBy: 'machine' })
    const second = upsertQaPlan(
      fixture.projectId,
      't1',
      // biome-ignore lint/suspicious/noThenProperty: GIVEN/WHEN/THEN domain language; never awaited
      { flows: [{ name: 'health ok', then: ['body says ok'] }, { name: 'second flow' }] },
      { mode: 'advisory' }
    )
    expect(second.plan?.flows.length).toBe(2)
    expect(second.plan?.flows[0]?.status).toBe('passed')
    expect(second.plan?.flows[0]?.then).toEqual(['body says ok'])
    expect(second.plan?.criteria.length).toBe(1)
  })

  it('resets a machine verdict when the probe changes', () => {
    const first = upsertQaPlan(
      fixture.projectId,
      't2',
      { flows: [{ name: 'health', probe: { type: 'http', path: '/health' } }] },
      { mode: 'advisory' }
    )
    const id = first.plan?.flows[0]?.id ?? ''
    markFlow(fixture.projectId, 't2', id, { status: 'passed', verifiedBy: 'machine' })
    const changed = upsertQaPlan(
      fixture.projectId,
      't2',
      { flows: [{ name: 'health', probe: { type: 'http', path: '/healthz' } }] },
      { mode: 'advisory' }
    )
    expect(changed.plan?.flows[0]?.status).toBe('pending')
    expect(changed.plan?.flows[0]?.verifiedBy).toBeUndefined()
  })

  it('strict refuses vague criteria and writes nothing; advisory warns and writes', () => {
    const strict = upsertQaPlan(
      fixture.projectId,
      't3',
      { criteria: ['it should feel fast and nice'] },
      { mode: 'strict' }
    )
    expect(strict.plan).toBe(null)
    expect(strict.rejected).toContain('Nyquist')
    expect(getQaPlan(fixture.projectId, 't3')).toBe(null)
    const advisory = upsertQaPlan(
      fixture.projectId,
      't3',
      { criteria: ['it should feel fast and nice'] },
      { mode: 'advisory' }
    )
    expect(advisory.plan?.criteria[0]?.verifiable).toBe(false)
    expect(advisory.report.ok).toBe(false)
  })
})

describe('applyQaReport', () => {
  it('records agent verdicts, maps blocked → skipped, and reports unknown ids', () => {
    const { plan } = upsertQaPlan(
      fixture.projectId,
      't4',
      {
        criteria: ['GET /health returns 200 — http probe'],
        flows: [{ name: 'login' }, { name: 'logout' }],
      },
      { mode: 'advisory' }
    )
    const [login, logout] = plan?.flows ?? []
    const ac = plan?.criteria[0]
    const result = applyQaReport(fixture.projectId, 't4', [
      { id: login?.id ?? '', verdict: 'passed', evidence: EVIDENCE },
      {
        id: logout?.id ?? '',
        verdict: 'blocked',
        evidence: `${EVIDENCE} no logout button rendered`,
      },
      { id: ac?.id ?? '', verdict: 'met', evidence: EVIDENCE },
      { id: 'fl-nope0000', verdict: 'passed', evidence: EVIDENCE },
    ])
    expect(result.unknown).toEqual(['fl-nope0000'])
    expect(result.applied.length).toBe(3)
    const next = result.plan
    expect(next?.flows[0]?.verifiedBy).toBe('agent')
    expect(next?.flows[0]?.status).toBe('passed')
    expect(next?.flows[1]?.status).toBe('skipped')
    expect(next?.flows[1]?.evidence?.startsWith('BLOCKED:')).toBe(true)
    expect(next?.criteria[0]?.status).toBe('met')
    expect(next?.criteria[0]?.verifiedBy).toBe('agent')
    const summary = qaPlanSummary(next!)
    expect(summary.flows).toMatchObject({ total: 2, passed: 1, skipped: 1, pending: 0 })
    expect(summary.criteria.met).toBe(1)
    const md = renderQaChecklistMd(next!).join('\n')
    expect(md).toContain('✓ agent')
    expect(md).toContain('⊘ skipped')
  })
})

describe('upsertQaPlan — remove', () => {
  it('drops the listed ids; everything else survives', () => {
    const { plan } = upsertQaPlan(
      fixture.projectId,
      't5',
      {
        criteria: ['GET /health returns 200 — http probe'],
        flows: [{ name: 'keep' }, { name: 'drop' }],
      },
      { mode: 'advisory' }
    )
    const drop = plan?.flows.find((f) => f.name === 'drop')?.id ?? ''
    const ac = plan?.criteria[0]?.id ?? ''
    const next = upsertQaPlan(fixture.projectId, 't5', { remove: [drop, ac] }, { mode: 'advisory' })
    expect(next.plan?.flows.map((f) => f.name)).toEqual(['keep'])
    expect(next.plan?.criteria).toEqual([])
  })
})
