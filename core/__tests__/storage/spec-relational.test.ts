/**
 * C6: a spec is projected into normalized child tables (acceptance criteria,
 * scope, risks, test steps, reviews, selected reviewers, linked tasks, tags) on
 * every write — the spec gate becomes queryable as relational records, not a
 * JSON blob. Re-projection on update stays consistent (clear + reinsert).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import prjctDb from '../../storage/database'
import { specStorage } from '../../storage/spec-storage'
import { emptySpecContent } from '../../types/spec'

const fixture: {
  projectId: string
  projectsDir: string
  originalProjectsDir: string | undefined
} = {
  projectId: '',
  projectsDir: '',
  originalProjectsDir: undefined as unknown as string | undefined,
}

describe('spec relational projection (C6)', () => {
  beforeEach(async () => {
    fixture.projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-spec-rel-'))
    fixture.originalProjectsDir = process.env.PRJCT_PROJECTS_DIR
    process.env.PRJCT_PROJECTS_DIR = fixture.projectsDir
    fixture.projectId = `specrel-${Date.now()}`
    prjctDb.run(fixture.projectId, 'SELECT 1 WHERE 1=0')
  })
  afterEach(async () => {
    if (fixture.originalProjectsDir === undefined) delete process.env.PRJCT_PROJECTS_DIR
    else process.env.PRJCT_PROJECTS_DIR = fixture.originalProjectsDir
    await fs.rm(fixture.projectsDir, { recursive: true, force: true })
  })

  function count(table: string, specId: string): number {
    return prjctDb.query<{ n: number }>(
      fixture.projectId,
      `SELECT COUNT(*) AS n FROM ${table} WHERE spec_id = ?`,
      specId
    )[0].n
  }

  it('projects list fields + tags into child tables on create', () => {
    const spec = specStorage.create(fixture.projectId, {
      title: 'Test spec',
      content: {
        ...emptySpecContent('goal here'),
        acceptance_criteria: ['ac1', 'ac2'],
        selected_reviewers: ['architecture', 'security'],
      },
      tags: { area: 'auth' },
    })
    // Only the gate state is projected relationally; the rest stays in the
    // specs.content aggregate (the sync root + read source of truth).
    expect(count('spec_selected_reviewer', spec.id)).toBe(2)
  })

  it('re-projects reviews on update — the relational gate state', () => {
    const spec = specStorage.create(fixture.projectId, {
      title: 'Gate spec',
      content: {
        ...emptySpecContent('goal'),
        selected_reviewers: ['architecture', 'security'],
      },
    })
    specStorage.updateContent(fixture.projectId, spec.id, {
      ...emptySpecContent('goal'),
      selected_reviewers: ['architecture', 'security'],
      reviews: {
        architecture: { verdict: 'pass', notes: 'ok', ts: new Date().toISOString() },
        security: { verdict: 'fail', notes: 'gap', ts: new Date().toISOString() },
      },
    })
    const reviews = prjctDb.query<{ lens: string; verdict: string }>(
      fixture.projectId,
      'SELECT lens, verdict FROM spec_review WHERE spec_id = ? ORDER BY lens',
      spec.id
    )
    expect(reviews.length).toBe(2)
    expect(reviews.find((r) => r.lens === 'architecture')?.verdict).toBe('pass')
    expect(reviews.find((r) => r.lens === 'security')?.verdict).toBe('fail')
    // Gate query: all selected reviewers have a pass?
    const pending = prjctDb.query<{ n: number }>(
      fixture.projectId,
      `SELECT COUNT(*) AS n FROM spec_selected_reviewer sr
       WHERE sr.spec_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM spec_review rv
           WHERE rv.spec_id = sr.spec_id AND rv.lens = sr.lens AND rv.verdict = 'pass'
         )`,
      spec.id
    )[0].n
    expect(pending).toBe(1) // security hasn't passed → gate not met
  })

  it('projection failure rolls back the content blob write (dual-write atomicity)', () => {
    const spec = specStorage.create(fixture.projectId, {
      title: 'Atomicity spec',
      content: { ...emptySpecContent('original goal'), selected_reviewers: ['architecture'] },
    })
    expect(count('spec_selected_reviewer', spec.id)).toBe(1)

    // Sabotage the projection target so projectSpecRelational throws inside
    // the write transaction.
    prjctDb.run(fixture.projectId, 'DROP TABLE spec_review')

    // The write path does not throw (best-effort projection), but the blob
    // UPDATE must have rolled back WITH the failed projection — the two
    // stores can no longer diverge.
    const updated = specStorage.updateContent(fixture.projectId, spec.id, {
      ...emptySpecContent('updated goal'),
      selected_reviewers: ['architecture'],
    })
    expect(updated?.content.goal).toBe('original goal')
    const stored = specStorage.get(fixture.projectId, spec.id)
    expect(stored?.content.goal).toBe('original goal')
    // Gate rows from the original create are untouched as well.
    expect(count('spec_selected_reviewer', spec.id)).toBe(1)
  })

  it('applyRemote (sync-pull) projects the gate for a genuinely NEW spec', () => {
    // Regression: a spec pulled from another machine, already fully reviewed
    // there, used to land its content blob but leave spec_review/
    // spec_selected_reviewer empty — reviewsGatePassedRelational would read
    // empty tables and report "not reviewed" for an already-approved spec.
    const remoteContent = {
      ...emptySpecContent('goal from remote'),
      selected_reviewers: ['architecture', 'security'],
      reviews: {
        architecture: { verdict: 'pass', notes: 'ok', ts: new Date().toISOString() },
        security: { verdict: 'pass', notes: 'ok', ts: new Date().toISOString() },
      },
    }
    specStorage.applyRemote(fixture.projectId, {
      id: 'remote-spec-1',
      title: 'Remote spec',
      status: 'reviewed',
      content: remoteContent,
    })

    expect(count('spec_selected_reviewer', 'remote-spec-1')).toBe(2)
    const reviews = prjctDb.query<{ lens: string; verdict: string }>(
      fixture.projectId,
      'SELECT lens, verdict FROM spec_review WHERE spec_id = ?',
      'remote-spec-1'
    )
    expect(reviews.length).toBe(2)
    expect(reviews.every((r) => r.verdict === 'pass')).toBe(true)
  })

  it('applyRemote never overwrites local gate state for an EXISTING spec (local wins)', () => {
    // "Local data is never modified by sync" invariant: if the spec already
    // exists locally, ON CONFLICT DO NOTHING skips the content INSERT, so the
    // relational projection must also skip — otherwise a stale/older remote
    // copy could silently rewrite the local (possibly newer) gate state.
    const spec = specStorage.create(fixture.projectId, {
      title: 'Local spec',
      content: { ...emptySpecContent('local goal'), selected_reviewers: ['architecture'] },
    })
    specStorage.updateContent(fixture.projectId, spec.id, {
      ...emptySpecContent('local goal'),
      selected_reviewers: ['architecture'],
      reviews: {
        architecture: { verdict: 'pass', notes: 'local pass', ts: new Date().toISOString() },
      },
    })
    expect(count('spec_selected_reviewer', spec.id)).toBe(1)

    // A remote copy of the SAME id arrives with no reviews at all.
    specStorage.applyRemote(fixture.projectId, {
      id: spec.id,
      title: 'Remote stale copy',
      status: 'draft',
      content: { ...emptySpecContent('local goal'), selected_reviewers: [] },
    })

    // Local gate state is untouched.
    expect(count('spec_selected_reviewer', spec.id)).toBe(1)
    const reviews = prjctDb.query<{ verdict: string }>(
      fixture.projectId,
      'SELECT verdict FROM spec_review WHERE spec_id = ?',
      spec.id
    )
    expect(reviews.length).toBe(1)
    expect(reviews[0].verdict).toBe('pass')
  })
})
