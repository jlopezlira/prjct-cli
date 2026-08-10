/**
 * Spec storage tests — exercise the SQLite-direct CRUD layer.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import prjctDb from '../../storage/database'
import { specStorage } from '../../storage/spec-storage'
import { emptySpecContent } from '../../types/spec'

const fixture: {
  tempProjectId: string
  tempProjectsDir: string
  originalProjectsDir: string | undefined
} = {
  tempProjectId: '',
  tempProjectsDir: '',
  originalProjectsDir: undefined as unknown as string | undefined,
}

describe('spec-storage', () => {
  beforeEach(async () => {
    fixture.tempProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-specs-test-'))
    fixture.originalProjectsDir = process.env.PRJCT_PROJECTS_DIR
    process.env.PRJCT_PROJECTS_DIR = fixture.tempProjectsDir
    fixture.tempProjectId = `test-${Date.now()}`
    // Touching the db on an unknown projectId triggers the migration chain
    // including v16 (specs + linked_spec_id), so the table exists.
    prjctDb.run(fixture.tempProjectId, 'SELECT 1 WHERE 1=0')
  })

  afterEach(async () => {
    if (fixture.originalProjectsDir === undefined) delete process.env.PRJCT_PROJECTS_DIR
    else process.env.PRJCT_PROJECTS_DIR = fixture.originalProjectsDir
    await fs.rm(fixture.tempProjectsDir, { recursive: true, force: true })
  })

  test('create + get round-trips structured content', () => {
    const spec = specStorage.create(fixture.tempProjectId, {
      title: 'rate limiting on auth',
      content: emptySpecContent('limit /auth to 10 req/min/IP'),
      tags: { domain: 'auth', priority: 'high' },
    })

    expect(spec.id).toBeTruthy()
    expect(spec.status).toBe('draft')
    expect(spec.content.goal).toBe('limit /auth to 10 req/min/IP')
    expect(spec.tags).toEqual({ domain: 'auth', priority: 'high' })

    const fetched = specStorage.get(fixture.tempProjectId, spec.id)
    expect(fetched).not.toBeNull()
    expect(fetched?.title).toBe('rate limiting on auth')
    expect(fetched?.content.goal).toBe('limit /auth to 10 req/min/IP')
  })

  test('list filters by status and excludes archived by default', () => {
    const a = specStorage.create(fixture.tempProjectId, {
      title: 'A',
      content: emptySpecContent('A goal'),
    })
    const b = specStorage.create(fixture.tempProjectId, {
      title: 'B',
      content: emptySpecContent('B goal'),
    })
    specStorage.setStatus(fixture.tempProjectId, b.id, 'archived')

    const live = specStorage.list(fixture.tempProjectId)
    expect(live.map((s) => s.id)).toEqual([a.id])

    const archived = specStorage.list(fixture.tempProjectId, { status: 'archived' })
    expect(archived.map((s) => s.id)).toEqual([b.id])

    const all = specStorage.list(fixture.tempProjectId, { includeArchived: true })
    expect(all.map((s) => s.id).sort()).toEqual([a.id, b.id].sort())
  })

  test('linkTask appends task ids idempotently', () => {
    const spec = specStorage.create(fixture.tempProjectId, {
      title: 'with tasks',
      content: emptySpecContent('goal'),
    })
    specStorage.linkTask(fixture.tempProjectId, spec.id, 'task-1')
    specStorage.linkTask(fixture.tempProjectId, spec.id, 'task-2')
    specStorage.linkTask(fixture.tempProjectId, spec.id, 'task-1') // duplicate
    const after = specStorage.get(fixture.tempProjectId, spec.id)
    expect(after?.content.linked_tasks).toEqual(['task-1', 'task-2'])
  })

  test('setStatus to shipped stamps shippedAt', () => {
    const spec = specStorage.create(fixture.tempProjectId, {
      title: 'shipping',
      content: emptySpecContent('goal'),
    })
    specStorage.setShippedPr(fixture.tempProjectId, spec.id, 42)
    const shipped = specStorage.setStatus(fixture.tempProjectId, spec.id, 'shipped')
    expect(shipped?.status).toBe('shipped')
    expect(shipped?.shippedAt).toBeTruthy()
    expect(shipped?.shippedPr).toBe(42)
  })

  test('count tracks status buckets', () => {
    const a = specStorage.create(fixture.tempProjectId, {
      title: 'A',
      content: emptySpecContent('A'),
    })
    specStorage.create(fixture.tempProjectId, {
      title: 'B',
      content: emptySpecContent('B'),
    })
    specStorage.setStatus(fixture.tempProjectId, a.id, 'shipped')
    const counts = specStorage.count(fixture.tempProjectId)
    expect(counts.total).toBe(2)
    expect(counts.draft).toBe(1)
    expect(counts.shipped).toBe(1)
  })

  test('updateContent validates via Zod', () => {
    const spec = specStorage.create(fixture.tempProjectId, {
      title: 'with criteria',
      content: emptySpecContent('original'),
    })
    const updated = specStorage.updateContent(fixture.tempProjectId, spec.id, {
      ...spec.content,
      goal: 'sharpened',
      acceptance_criteria: ['returns 429 on the 11th request'],
    })
    expect(updated?.content.goal).toBe('sharpened')
    expect(updated?.content.acceptance_criteria).toEqual(['returns 429 on the 11th request'])
  })
})
