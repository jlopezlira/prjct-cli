/**
 * Dynamic audit-spec lenses.
 *
 * `selectReviewers` is the deterministic baseline (no LLM): `architecture`
 * is the floor; lenses are added when the spec text signals their concern.
 * `reviewsGatePassedRelational` is the auto-promote gate over the SELECTED
 * set (read from spec_selected_reviewer/spec_review, C6), with a legacy
 * fallback to the three baseline lenses when no set was recorded.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { LENS_CATALOG } from '../../services/review-lenses'
import {
  renderAuditDispatch,
  reviewsGatePassedRelational,
  selectReviewers,
} from '../../services/spec-audit-dispatch'
import prjctDb from '../../storage/database'
import { emptySpecContent } from '../../types/spec'
import type { DomainDefinition } from '../../types/storage/extended'

describe('selectReviewers — dynamic baseline', () => {
  it('picks ONLY architecture for a trivial spec', () => {
    expect(selectReviewers(emptySpecContent('Fix a typo in the README'))).toEqual(['architecture'])
  })

  it('adds security + data for an auth + migration spec', () => {
    const lenses = selectReviewers(emptySpecContent('Add token auth and a DB schema migration'))
    expect(lenses).toContain('architecture')
    expect(lenses).toContain('security')
    expect(lenses).toContain('data')
    expect(lenses.length).toBeGreaterThanOrEqual(3)
  })

  it('adds design for a CLI/UI surface spec', () => {
    expect(selectReviewers(emptySpecContent('New CLI command with --flag output'))).toContain(
      'design'
    )
  })

  it('adds strategic when scope is large', () => {
    const c = emptySpecContent('Big refactor')
    c.scope = ['a', 'b', 'c', 'd', 'e']
    expect(selectReviewers(c)).toContain('strategic')
  })

  it('adds strategic when stakes are set', () => {
    const c = emptySpecContent('Risky change')
    c.stakes = 'breaks billing if wrong'
    expect(selectReviewers(c)).toContain('strategic')
  })
})

describe('reviewsGatePassedRelational — gate over the selected set (C6)', () => {
  const fixture: {
    projectId: string
    projectsDir: string
    originalProjectsDir: string | undefined
  } = {
    projectId: '',
    projectsDir: '',
    originalProjectsDir: undefined as unknown as string | undefined,
  }

  beforeEach(async () => {
    fixture.projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-gate-rel-'))
    fixture.originalProjectsDir = process.env.PRJCT_PROJECTS_DIR
    process.env.PRJCT_PROJECTS_DIR = fixture.projectsDir
    fixture.projectId = `gaterel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    prjctDb.run(fixture.projectId, 'SELECT 1 WHERE 1=0')
  })
  afterEach(async () => {
    if (fixture.originalProjectsDir === undefined) delete process.env.PRJCT_PROJECTS_DIR
    else process.env.PRJCT_PROJECTS_DIR = fixture.originalProjectsDir
    await fs.rm(fixture.projectsDir, { recursive: true, force: true })
  })

  const specId = 'gate-spec'
  function seed(selected: string[], verdicts: Record<string, 'pass' | 'fail'>): void {
    for (const lens of selected) {
      prjctDb.run(
        fixture.projectId,
        'INSERT INTO spec_selected_reviewer (spec_id, lens) VALUES (?, ?)',
        specId,
        lens
      )
    }
    for (const [lens, verdict] of Object.entries(verdicts)) {
      prjctDb.run(
        fixture.projectId,
        'INSERT INTO spec_review (id, spec_id, lens, verdict, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        `${specId}-${lens}`,
        specId,
        lens,
        verdict,
        'notes',
        new Date().toISOString()
      )
    }
  }

  it('passes when every selected lens passed', () => {
    seed(['architecture', 'security'], { architecture: 'pass', security: 'pass' })
    expect(reviewsGatePassedRelational(fixture.projectId, specId)).toBe(true)
  })

  it('fails when a selected lens failed', () => {
    seed(['architecture', 'security'], { architecture: 'pass', security: 'fail' })
    expect(reviewsGatePassedRelational(fixture.projectId, specId)).toBe(false)
  })

  it('fails when a selected lens is missing', () => {
    seed(['architecture', 'security'], { architecture: 'pass' })
    expect(reviewsGatePassedRelational(fixture.projectId, specId)).toBe(false)
  })

  it('does NOT require unselected lenses (a 1-lens spec promotes on 1 pass)', () => {
    seed(['architecture'], { architecture: 'pass' })
    expect(reviewsGatePassedRelational(fixture.projectId, specId)).toBe(true)
  })

  it('legacy fallback: empty selected set ⇒ the three baseline lenses', () => {
    seed([], { strategic: 'pass', architecture: 'pass', design: 'pass' })
    expect(reviewsGatePassedRelational(fixture.projectId, specId)).toBe(true)
  })

  it('legacy fallback: partial baseline (2 of 3) does not promote', () => {
    seed([], { strategic: 'pass', architecture: 'pass' })
    expect(reviewsGatePassedRelational(fixture.projectId, specId)).toBe(false)
  })

  it('no reviews at all ⇒ false', () => {
    expect(reviewsGatePassedRelational(fixture.projectId, specId)).toBe(false)
  })
})

describe('renderAuditDispatch — never names a model', () => {
  // Lenses used to opt down to a cheaper model class ("capabilityClass: fast"),
  // and the dispatch carried a global review-tier directive. Both capped the
  // reviewer below the model the user chose to run. Neither may come back.
  const FORBIDDEN = ['model: "haiku"', 'model: "sonnet"', 'model: "opus"', 'over-deliberate']

  it('emits no model directive for any lens', async () => {
    const out = await renderAuditDispatch(
      'spec_1',
      'T',
      emptySpecContent('x'),
      ['architecture', 'design', 'security'],
      'claude'
    )
    expect(out).toContain('### Lens: design (UX/DX)')
    for (const needle of FORBIDDEN) expect(out).not.toContain(needle)
    expect(out).toContain('Do not set `model:` on any reviewer')
    expect(out).toContain('at most 2 reviewer agents')
  })

  it('bundles all selected lenses into at most two agents', async () => {
    const chosen = ['architecture', 'strategic', 'design', 'security', 'data', 'performance']
    const out = await renderAuditDispatch('spec_1', 'T', emptySpecContent('x'), chosen, 'claude')

    expect(out).toContain('## Reviewer agent A')
    expect(out).toContain('## Reviewer agent B')
    expect(out).not.toContain('## Reviewer agent C')
    for (const lens of chosen) expect(out).toContain(`### Lens: ${lens}`)
  })

  it('no catalog lens carries a capability-class override', () => {
    for (const spec of Object.values(LENS_CATALOG)) {
      expect('capabilityClass' in spec).toBe(false)
    }
  })
})

describe('selectReviewers — DOMAIN experts (GAP 1)', () => {
  const authDomain: DomainDefinition = {
    name: 'auth',
    description: 'Authentication + sessions',
    keywords: ['login', 'session'],
    filePatterns: ['**/auth/**'],
    fileCount: 5,
  }

  it('adds the domain expert when a scope path matches its filePatterns', () => {
    const c = emptySpecContent('Add a thing')
    c.scope = ['core/auth/login.ts']
    const lenses = selectReviewers(c, [authDomain])
    expect(lenses).toContain('auth')
    expect(lenses).toContain('architecture')
  })

  it('adds the domain expert when its keywords hit the spec text', () => {
    expect(selectReviewers(emptySpecContent('Refactor the login flow'), [authDomain])).toContain(
      'auth'
    )
  })

  it('does NOT shadow a function lens with a same-named domain', () => {
    const dataDomain: DomainDefinition = {
      name: 'data',
      description: 'x',
      keywords: ['table'],
      filePatterns: [],
      fileCount: 1,
    }
    // 'table' triggers the built-in `data` function lens; the domain must not duplicate it.
    const lenses = selectReviewers(emptySpecContent('add a table migration'), [dataDomain])
    expect(lenses.filter((l) => l === 'data').length).toBe(1)
  })

  it('no domains ⇒ byte-identical to the function-only baseline', () => {
    const c = emptySpecContent('Add token auth and a DB schema migration')
    expect(selectReviewers(c, [])).toEqual(selectReviewers(c))
  })
})

describe('renderAuditDispatch — domain reviewer section (GAP 1)', () => {
  it('emits the domain-expert rubric for a matched domain', async () => {
    const authDomain: DomainDefinition = {
      name: 'auth',
      description: 'Authentication + sessions',
      keywords: ['login'],
      filePatterns: ['**/auth/**'],
      fileCount: 5,
    }
    const c = emptySpecContent('Refactor the login flow')
    c.scope = ['core/auth/login.ts']
    const out = await renderAuditDispatch('spec_d', 'T', c, undefined, 'claude', [authDomain])
    expect(out).toContain('auth (domain expert)')
    expect(out).toContain('domain specialist')
    expect(out).toContain('prjct context memory auth')
  })
})
