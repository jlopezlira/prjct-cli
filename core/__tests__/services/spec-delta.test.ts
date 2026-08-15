/**
 * Spec deltas (Phase 1) — parser + applier + service wiring. Pins:
 *   - ADDED / MODIFIED / REMOVED section parsing (strict OpenSpec subset)
 *   - scenario GIVEN/WHEN/THEN bullets (bold or bare, AND continuations)
 *   - requirement name → stable slug; statement → acceptance criterion
 *   - idempotent re-apply by delta id (content-hash by default)
 *   - convergence: same delta set applied in different orders ⇒ deep-equal
 *   - drift demotion fires through specService.applyDelta (C1 fail-closed)
 *
 * Service-level tests mirror the fixture pattern of spec-patch.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import { computeAuditCandidateHash } from '../../services/spec-audit-dispatch'
import {
  applyDelta,
  materializeDeltas,
  parseDelta,
  slugifyRequirement,
} from '../../services/spec-delta'
import { specService } from '../../services/spec-service'
import prjctDb from '../../storage/database'
import { emptySpecContent } from '../../types/spec'

const ADDED_AUTH = `## ADDED Requirements

### Requirement: User Authentication
The system SHALL authenticate requests via bearer tokens.

#### Scenario: valid token
- **GIVEN** a valid token
- **WHEN** the request arrives
- **THEN** access is granted
- **AND** the request is logged

#### Scenario: expired token
- GIVEN an expired token
- WHEN the request arrives
- THEN access is denied
`

const ADDED_RATE_LIMIT = `## ADDED Requirements

### Requirement: Rate Limiting
The system SHALL limit /auth to 10 req/min/IP.
`

const ADDED_CACHING = `## ADDED Requirements

### Requirement: Response Caching
The system SHALL cache GET responses for 60s.
`

const MODIFIED_AUTH = `## MODIFIED Requirements

### Requirement: User Authentication
The system SHALL authenticate requests via bearer tokens and refresh them.

#### Scenario: valid token
- **GIVEN** a valid token
- **WHEN** the request arrives
- **THEN** access is granted
`

const REMOVED_RATE_LIMIT = `## REMOVED Requirements

### Requirement: Rate Limiting
`

describe('slugifyRequirement', () => {
  test('lowercase, non-alphanumeric runs collapse to single dashes', () => {
    expect(slugifyRequirement('User Authentication')).toBe('user-authentication')
    expect(slugifyRequirement('  Rate  Limiting!! ')).toBe('rate-limiting')
  })
})

describe('parseDelta', () => {
  test('parses an ADDED section with scenarios (bold + bare bullets, AND continuation)', () => {
    const ops = parseDelta(ADDED_AUTH)
    expect(ops.modified).toEqual([])
    expect(ops.removed).toEqual([])
    expect(ops.added).toHaveLength(1)
    const req = ops.added[0]
    expect(req.slug).toBe('user-authentication')
    expect(req.name).toBe('User Authentication')
    expect(req.statement).toBe('The system SHALL authenticate requests via bearer tokens.')
    expect(req.scenarios).toHaveLength(2)
    expect(req.scenarios[0]).toEqual({
      name: 'valid token',
      given: ['a valid token'],
      when: ['the request arrives'],
      // biome-ignore lint/suspicious/noThenProperty: GIVEN/WHEN/THEN domain language; never awaited
      then: ['access is granted', 'the request is logged'],
    })
    // Bare bullets (no ** markers) parse the same way.
    expect(req.scenarios[1]).toEqual({
      name: 'expired token',
      given: ['an expired token'],
      when: ['the request arrives'],
      // biome-ignore lint/suspicious/noThenProperty: GIVEN/WHEN/THEN domain language; never awaited
      then: ['access is denied'],
    })
  })

  test('parses MODIFIED and REMOVED sections; REMOVED keeps slugs only', () => {
    const mod = parseDelta(MODIFIED_AUTH)
    expect(mod.modified[0].slug).toBe('user-authentication')
    expect(mod.modified[0].statement).toContain('refresh them')

    const rem = parseDelta(REMOVED_RATE_LIMIT)
    expect(rem.removed).toEqual(['rate-limiting'])
    expect(rem.added).toEqual([])
  })

  test('requirement outside a section throws; empty delta throws', () => {
    expect(() => parseDelta('### Requirement: Orphan\nstatement')).toThrow(/DELTA_PARSE/)
    expect(() => parseDelta('# just a title\n\nsome prose')).toThrow(/DELTA_EMPTY/)
    expect(() => parseDelta('## ADDED Requirements\n\n### Requirement: No Statement\n')).toThrow(
      /DELTA_PARSE/
    )
  })
})

describe('applyDelta (pure)', () => {
  test('ADDED appends the statement as an AC and keys scenarios by slug', () => {
    const base = emptySpecContent('goal')
    const next = applyDelta(base, ADDED_AUTH, { ts: '2026-01-01T00:00:01.000Z' })
    expect(next.acceptance_criteria).toEqual([
      'The system SHALL authenticate requests via bearer tokens.',
    ])
    expect(next.scenarios['user-authentication']).toHaveLength(2)
    expect(next.delta_log).toHaveLength(1)
    expect(next.delta_log[0].id).toMatch(/^delta-[0-9a-f]{12}$/)
    expect(next.delta_log[0].ops.added[0].slug).toBe('user-authentication')
    // Untouched fields survive.
    expect(next.goal).toBe('goal')
  })

  test('hand-written ACs are preserved ahead of delta-managed ones', () => {
    const base = { ...emptySpecContent('goal'), acceptance_criteria: ['manual AC'] }
    const next = applyDelta(base, ADDED_RATE_LIMIT, { ts: '2026-01-01T00:00:01.000Z' })
    expect(next.acceptance_criteria).toEqual([
      'manual AC',
      'The system SHALL limit /auth to 10 req/min/IP.',
    ])
  })

  test('MODIFIED replaces statement + scenarios of an existing slug', () => {
    const base = applyDelta(emptySpecContent('goal'), ADDED_AUTH, {
      ts: '2026-01-01T00:00:01.000Z',
    })
    const next = applyDelta(base, MODIFIED_AUTH, { ts: '2026-01-01T00:00:02.000Z' })
    expect(next.acceptance_criteria).toEqual([
      'The system SHALL authenticate requests via bearer tokens and refresh them.',
    ])
    // Scenarios replaced wholesale: 2 → 1.
    expect(next.scenarios['user-authentication']).toHaveLength(1)
    expect(next.delta_log).toHaveLength(2)
  })

  test('REMOVED deletes statement + scenarios', () => {
    const base = applyDelta(
      applyDelta(emptySpecContent('goal'), ADDED_AUTH, { ts: '2026-01-01T00:00:01.000Z' }),
      ADDED_RATE_LIMIT,
      { ts: '2026-01-01T00:00:02.000Z' }
    )
    const next = applyDelta(base, REMOVED_RATE_LIMIT, { ts: '2026-01-01T00:00:03.000Z' })
    expect(next.acceptance_criteria).toEqual([
      'The system SHALL authenticate requests via bearer tokens.',
    ])
    expect(next.scenarios['rate-limiting']).toBeUndefined()
  })

  test('MODIFIED/REMOVED of an unknown slug throws', () => {
    const base = emptySpecContent('goal')
    expect(() => applyDelta(base, MODIFIED_AUTH)).toThrow(/DELTA_UNKNOWN_REQUIREMENT/)
    expect(() => applyDelta(base, REMOVED_RATE_LIMIT)).toThrow(/DELTA_UNKNOWN_REQUIREMENT/)
  })

  test('re-applying the same delta is a no-op (idempotent by delta id)', () => {
    const base = applyDelta(emptySpecContent('goal'), ADDED_AUTH, {
      ts: '2026-01-01T00:00:01.000Z',
    })
    const again = applyDelta(base, ADDED_AUTH, { ts: '2026-01-01T00:00:01.000Z' })
    expect(again).toBe(base) // same reference — nothing changed
    expect(again.delta_log).toHaveLength(1)
  })

  test('convergence: same delta set applied in different orders ⇒ deep-equal content', () => {
    const t1 = { ts: '2026-01-01T00:00:01.000Z' }
    const t2 = { ts: '2026-01-01T00:00:02.000Z' }
    const t3 = { ts: '2026-01-01T00:00:03.000Z' }
    const forward = applyDelta(
      applyDelta(applyDelta(emptySpecContent('goal'), ADDED_AUTH, t1), ADDED_RATE_LIMIT, t2),
      ADDED_CACHING,
      t3
    )
    const reverse = applyDelta(
      applyDelta(applyDelta(emptySpecContent('goal'), ADDED_CACHING, t3), ADDED_RATE_LIMIT, t2),
      ADDED_AUTH,
      t1
    )
    expect(reverse).toEqual(forward)
  })

  test('re-materialization is total: MODIFIED without a prior ADDED folds as an add', () => {
    // The sync merge re-materializes from the union log, so the fold must be
    // order-tolerant: a MODIFIED that "arrives" before its ADDED still lands.
    const entry = { id: 'delta-x', ts: '2026-01-01T00:00:02.000Z', ops: parseDelta(MODIFIED_AUTH) }
    const out = materializeDeltas([entry])
    expect(out.acceptance_criteria).toEqual([
      'The system SHALL authenticate requests via bearer tokens and refresh them.',
    ])
    // And applied content always equals its own re-materialization.
    const applied = applyDelta(
      applyDelta(emptySpecContent('goal'), ADDED_AUTH, { ts: '2026-01-01T00:00:01.000Z' }),
      MODIFIED_AUTH,
      { ts: '2026-01-01T00:00:02.000Z' }
    )
    const rematerialized = materializeDeltas(applied.delta_log)
    expect(applied.acceptance_criteria).toEqual(rematerialized.acceptance_criteria)
    expect(applied.scenarios).toEqual(rematerialized.scenarios)
  })

  test('scenario edits change the audit candidate hash (reviews invalidate)', () => {
    const base = applyDelta(emptySpecContent('goal'), ADDED_AUTH, {
      ts: '2026-01-01T00:00:01.000Z',
    })
    const modified = applyDelta(base, MODIFIED_AUTH, { ts: '2026-01-01T00:00:02.000Z' })
    expect(computeAuditCandidateHash(modified)).not.toBe(computeAuditCandidateHash(base))
  })
})

// ---------------------------------------------------------------------------
// Service-level: drift demotion flows through specService.applyDelta.
// ---------------------------------------------------------------------------

const fixture: {
  projectPath: string
  projectId: string
  originalProjectsDir: string | undefined
} = {
  projectPath: '',
  projectId: '',
  originalProjectsDir: undefined as unknown as string | undefined,
}

async function freshProject(): Promise<void> {
  const tempProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-spec-delta-pd-'))
  fixture.originalProjectsDir = process.env.PRJCT_PROJECTS_DIR
  process.env.PRJCT_PROJECTS_DIR = tempProjectsDir

  fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-spec-delta-'))
  await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
  fixture.projectId = `delta-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await configManager.writeConfig(fixture.projectPath, {
    projectId: fixture.projectId,
    dataPath: path.join(fixture.projectPath, '.prjct-data'),
  } as Parameters<typeof configManager.writeConfig>[1])
  await pathManager.ensureProjectStructure(fixture.projectId)
  prjctDb.run(fixture.projectId, 'SELECT 1 WHERE 1=0')
}

describe('specService.applyDelta', () => {
  beforeEach(async () => {
    prjctDb.close()
    await freshProject()
  })

  afterEach(async () => {
    if (fixture.originalProjectsDir === undefined) delete process.env.PRJCT_PROJECTS_DIR
    else process.env.PRJCT_PROJECTS_DIR = fixture.originalProjectsDir
    if (fixture.projectPath)
      await fs.rm(fixture.projectPath, { recursive: true, force: true }).catch(() => {})
    prjctDb.close()
  })

  test('applies a delta onto a stored spec; re-apply is a no-op', async () => {
    const created = await specService.create(fixture.projectPath, {
      title: 'delta target',
      content: { goal: 'ship auth' },
      autoContext: false,
    })

    const updated = await specService.applyDelta(fixture.projectPath, created.id, ADDED_AUTH)
    expect(updated?.content.acceptance_criteria).toEqual([
      'The system SHALL authenticate requests via bearer tokens.',
    ])
    expect(updated?.content.scenarios['user-authentication']).toHaveLength(2)
    expect(updated?.content.delta_log).toHaveLength(1)

    const again = await specService.applyDelta(fixture.projectPath, created.id, ADDED_AUTH)
    expect(again?.content.delta_log).toHaveLength(1)
    expect(again?.updatedAt).toBe(updated?.updatedAt)
  })

  test('body drift demotes reviewed → draft and clears reviews (C1)', async () => {
    const created = await specService.create(fixture.projectPath, {
      title: 'delta drift',
      content: { goal: 'original goal', acceptance_criteria: ['AC 1'] },
      autoContext: false,
    })
    await specService.recordReview(fixture.projectPath, created.id, 'architecture', {
      verdict: 'pass',
      notes: 'ok',
    })
    await specService.setStatus(fixture.projectPath, created.id, 'reviewed')

    await specService.applyDelta(fixture.projectPath, created.id, ADDED_RATE_LIMIT)

    const refreshed = await specService.get(fixture.projectPath, created.id)
    expect(refreshed?.status).toBe('draft')
    expect(refreshed?.content.reviews?.architecture).toBeUndefined()
    expect(refreshed?.content.audit_candidate_hash).toBeNull()
    // Hand-written AC preserved; delta-managed AC appended.
    expect(refreshed?.content.acceptance_criteria).toEqual([
      'AC 1',
      'The system SHALL limit /auth to 10 req/min/IP.',
    ])
  })

  test('unknown spec id returns null; unknown MODIFIED target throws', async () => {
    const missing = await specService.applyDelta(
      fixture.projectPath,
      '00000000-0000-0000-0000-000000000000',
      ADDED_AUTH
    )
    expect(missing).toBeNull()

    const created = await specService.create(fixture.projectPath, {
      title: 'strict targets',
      content: { goal: 'g' },
      autoContext: false,
    })
    await expect(
      specService.applyDelta(fixture.projectPath, created.id, MODIFIED_AUTH)
    ).rejects.toThrow(/DELTA_UNKNOWN_REQUIREMENT/)
  })
})
