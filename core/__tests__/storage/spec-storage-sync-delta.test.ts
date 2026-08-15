/**
 * applyRemote delta-union convergence (Phase 1 / spec deltas). Pins:
 *   - conflict with disjoint delta logs merges to the union on BOTH
 *     directions (A-pulls-B and B-pulls-A yield deep-equal content)
 *   - scalar fields resolve last-writer-wins by updated_at
 *   - a real merge clears the review gate state (conservative)
 *   - legacy bodies (either side without a delta_log) keep the old
 *     DO NOTHING behavior — sync never rewrites a pre-delta local spec
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { applyDelta } from '../../services/spec-delta'
import prjctDb from '../../storage/database'
import { specStorage } from '../../storage/spec-storage'
import { emptySpecContent, type SpecContent } from '../../types/spec'

const ADDED_AUTH = `## ADDED Requirements

### Requirement: User Authentication
The system SHALL authenticate requests via bearer tokens.

#### Scenario: valid token
- **GIVEN** a valid token
- **WHEN** the request arrives
- **THEN** access is granted
`

const ADDED_RATE_LIMIT = `## ADDED Requirements

### Requirement: Rate Limiting
The system SHALL limit /auth to 10 req/min/IP.
`

const SPEC_ID = '11111111-2222-3333-4444-555555555555'
const TS_A = '2026-01-01T00:00:01.000Z'
const TS_B = '2026-01-01T00:00:02.000Z'

const fixture: {
  tempProjectsDir: string
  originalProjectsDir: string | undefined
  projectIds: string[]
} = {
  tempProjectsDir: '',
  originalProjectsDir: undefined as unknown as string | undefined,
  projectIds: [],
}

function freshProjectId(label: string): string {
  const id = `sync-delta-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  fixture.projectIds.push(id)
  prjctDb.run(id, 'SELECT 1 WHERE 1=0')
  return id
}

/** Build the two diverged bodies from a shared base. */
function divergedContents(): { contentA: SpecContent; contentB: SpecContent } {
  const base = emptySpecContent('shared goal')
  const contentA = applyDelta(base, ADDED_AUTH, { ts: TS_A })
  const contentB = applyDelta({ ...base, notes: 'edited on machine B' }, ADDED_RATE_LIMIT, {
    ts: TS_B,
  })
  return { contentA, contentB }
}

function remoteRow(content: SpecContent, updatedAt: string) {
  return {
    id: SPEC_ID,
    title: 'shared spec',
    status: 'draft',
    content,
    created_at: updatedAt,
    updated_at: updatedAt,
  }
}

describe('spec-storage applyRemote — delta union', () => {
  beforeEach(async () => {
    fixture.tempProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-spec-sync-delta-'))
    fixture.originalProjectsDir = process.env.PRJCT_PROJECTS_DIR
    process.env.PRJCT_PROJECTS_DIR = fixture.tempProjectsDir
    fixture.projectIds = []
  })

  afterEach(async () => {
    if (fixture.originalProjectsDir === undefined) delete process.env.PRJCT_PROJECTS_DIR
    else process.env.PRJCT_PROJECTS_DIR = fixture.originalProjectsDir
    await fs.rm(fixture.tempProjectsDir, { recursive: true, force: true }).catch(() => {})
    prjctDb.close()
  })

  test('disjoint delta logs converge to the same content in both directions', () => {
    const { contentA, contentB } = divergedContents()

    // Machine A: local A, pulls B.
    const pidA = freshProjectId('a')
    specStorage.applyRemote(pidA, remoteRow(contentA, TS_A))
    specStorage.applyRemote(pidA, remoteRow(contentB, TS_B))
    const mergedA = specStorage.get(pidA, SPEC_ID)

    // Machine B: local B, pulls A.
    const pidB = freshProjectId('b')
    specStorage.applyRemote(pidB, remoteRow(contentB, TS_B))
    specStorage.applyRemote(pidB, remoteRow(contentA, TS_A))
    const mergedB = specStorage.get(pidB, SPEC_ID)

    expect(mergedA).not.toBeNull()
    expect(mergedB).not.toBeNull()
    // Full deep equality: same merged log, same materialized requirements,
    // same scalar base (B is the later writer in both directions).
    expect(mergedA?.content).toEqual(mergedB?.content)

    // Union of both deltas, sorted by (ts, id).
    expect(mergedA?.content.delta_log.map((e) => e.ts)).toEqual([TS_A, TS_B])
    // Both requirements materialized, in delta order.
    expect(mergedA?.content.acceptance_criteria).toEqual([
      'The system SHALL authenticate requests via bearer tokens.',
      'The system SHALL limit /auth to 10 req/min/IP.',
    ])
    expect(mergedA?.content.scenarios['user-authentication']).toHaveLength(1)
    // Scalar LWW by updated_at: B is newer → its notes win.
    expect(mergedA?.content.notes).toBe('edited on machine B')
  })

  test('re-applying an already-merged remote is a no-op (converged)', () => {
    const { contentA, contentB } = divergedContents()
    const pid = freshProjectId('noop')
    specStorage.applyRemote(pid, remoteRow(contentA, TS_A))
    specStorage.applyRemote(pid, remoteRow(contentB, TS_B))
    const mergedContent = specStorage.get(pid, SPEC_ID)?.content

    // B pulls the merged result (echo from A) and converges onto it.
    const pid2 = freshProjectId('echo')
    specStorage.applyRemote(pid2, remoteRow(contentB, TS_B))
    specStorage.applyRemote(pid2, { ...remoteRow(contentA, TS_A), content: mergedContent })
    const converged = specStorage.get(pid2, SPEC_ID)
    expect(converged?.content).toEqual(mergedContent)

    // Pulling the same merged body again must not write anything.
    const updatedAtAfterConverge = converged?.updatedAt
    specStorage.applyRemote(pid2, { ...remoteRow(contentA, TS_A), content: mergedContent })
    const after = specStorage.get(pid2, SPEC_ID)
    expect(after?.content).toEqual(mergedContent)
    expect(after?.updatedAt).toBe(updatedAtAfterConverge)
  })

  test('a real merge clears the review gate state', () => {
    const { contentA, contentB } = divergedContents()
    const reviewedA: SpecContent = {
      ...contentA,
      reviews: { architecture: { verdict: 'pass', notes: 'ok', ts: TS_A } },
      selected_reviewers: ['architecture'],
      audit_candidate_hash: 'frozen-hash',
    }
    const pid = freshProjectId('reviews')
    specStorage.applyRemote(pid, remoteRow(reviewedA, TS_A))
    specStorage.applyRemote(pid, remoteRow(contentB, TS_B))
    const merged = specStorage.get(pid, SPEC_ID)
    expect(merged?.content.delta_log).toHaveLength(2)
    expect(merged?.content.reviews).toEqual({})
    expect(merged?.content.selected_reviewers).toEqual([])
    expect(merged?.content.audit_candidate_hash).toBeNull()
  })

  test('legacy bodies (no delta_log either side) stay DO NOTHING', () => {
    const pid = freshProjectId('legacy')
    const localContent = emptySpecContent('local goal')
    specStorage.applyRemote(pid, remoteRow(localContent, TS_A))
    const before = specStorage.get(pid, SPEC_ID)

    specStorage.applyRemote(pid, {
      ...remoteRow(emptySpecContent('remote goal'), TS_B),
      title: 'remote title',
    })
    const after = specStorage.get(pid, SPEC_ID)
    expect(after?.content).toEqual(before?.content)
    expect(after?.title).toBe('shared spec') // untouched local row
  })

  test('mixed bodies (local has deltas, remote legacy) stay DO NOTHING', () => {
    const { contentA } = divergedContents()
    const pid = freshProjectId('mixed')
    specStorage.applyRemote(pid, remoteRow(contentA, TS_A))
    const before = specStorage.get(pid, SPEC_ID)

    specStorage.applyRemote(pid, remoteRow(emptySpecContent('legacy remote'), TS_B))
    const after = specStorage.get(pid, SPEC_ID)
    expect(after?.content).toEqual(before?.content)
  })
})
