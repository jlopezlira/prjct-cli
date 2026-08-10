/**
 * Plan-mode SQLite storage
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { prjctDb } from '../../storage/database'
import { emptyPlanTemplate, planStorage } from '../../storage/plan-storage'

const fixture: {
  tempProjectsDir: string
  prevProjectsDir: string | undefined
  projectId: string
} = {
  tempProjectsDir: '',
  prevProjectsDir: undefined as unknown as string | undefined,
  projectId: '',
}

beforeEach(() => {
  fixture.tempProjectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prjct-plan-storage-'))
  fixture.prevProjectsDir = process.env.PRJCT_PROJECTS_DIR
  process.env.PRJCT_PROJECTS_DIR = fixture.tempProjectsDir
  fixture.projectId = `plan-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  prjctDb.get(fixture.projectId, 'SELECT 1')
})

afterEach(() => {
  if (fixture.prevProjectsDir === undefined) delete process.env.PRJCT_PROJECTS_DIR
  else process.env.PRJCT_PROJECTS_DIR = fixture.prevProjectsDir
  // Leave the temp dir for the open SQLite handle; process exit cleans /tmp.
  // Deleting while bun:sqlite still holds the file causes disk I/O errors.
})

describe('planStorage', () => {
  it('starts a draft with Grok-style sections', () => {
    const plan = planStorage.start(fixture.projectId, 'Add caching')
    expect(plan.status).toBe('draft')
    expect(plan.title).toBe('Add caching')
    expect(plan.content).toContain('## Context')
    expect(plan.content).toContain('## Recommended approach')
    expect(plan.content).toContain('## Critical files')
    expect(plan.content).toContain('## Reuse')
    expect(plan.content).toContain('## Verification')
    expect(planStorage.get(fixture.projectId)?.title).toBe('Add caching')
  })

  it('writeContent only works on draft', () => {
    planStorage.start(fixture.projectId, 'X')
    const body = emptyPlanTemplate('X').replace('Why this change is needed.', 'Need Redis')
    const written = planStorage.writeContent(fixture.projectId, body)
    expect(written?.content).toContain('Need Redis')

    planStorage.approve(fixture.projectId)
    expect(planStorage.writeContent(fixture.projectId, 'nope')).toBeNull()
  })

  it('approve transitions draft → approved', () => {
    planStorage.start(fixture.projectId, 'Auth')
    const approved = planStorage.approve(fixture.projectId)
    expect(approved?.status).toBe('approved')
    expect(approved?.approvedAt).toBeTruthy()
    expect(planStorage.approve(fixture.projectId)).toBeNull()
  })

  it('clear removes the row', () => {
    planStorage.start(fixture.projectId, 'Tmp')
    planStorage.clear(fixture.projectId)
    expect(planStorage.get(fixture.projectId)).toBeNull()
  })
})
