/**
 * sync_applied_hashes — unit tests.
 *
 * Pins the contract:
 *   - getApplied returns null on miss / error / empty inputs.
 *   - recordApplied UPSERTs (one row per entity_type/entity_id).
 *   - Hash overwrites cleanly on subsequent recordApplied calls.
 *   - Empty/missing inputs are no-ops (don't blow up, don't write garbage).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'
import prjctDb from '../../storage/database'
import { clearApplied, getApplied, recordApplied } from '../../sync/sync-applied-hashes'

const fixture: {
  projectId: string
  originalProjectsDir: string | undefined
} = {
  projectId: '',
  originalProjectsDir: undefined as unknown as string | undefined,
}

beforeEach(async () => {
  prjctDb.close()
  const tempProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-applied-hashes-'))
  fixture.originalProjectsDir = process.env.PRJCT_PROJECTS_DIR
  process.env.PRJCT_PROJECTS_DIR = tempProjectsDir
  fixture.projectId = `applied-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await pathManager.ensureProjectStructure(fixture.projectId)
  // Force migrations to run by hitting the DB once.
  prjctDb.run(fixture.projectId, 'SELECT 1 WHERE 1=0')
})

afterEach(() => {
  if (fixture.originalProjectsDir === undefined) delete process.env.PRJCT_PROJECTS_DIR
  else process.env.PRJCT_PROJECTS_DIR = fixture.originalProjectsDir
  prjctDb.close()
})

describe('sync-applied-hashes', () => {
  test('getApplied returns null when no row exists', () => {
    expect(getApplied(fixture.projectId, 'tasks', 'task-A')).toBeNull()
  })

  test('recordApplied + getApplied round-trip', () => {
    recordApplied(fixture.projectId, 'tasks', 'task-A', 'sha256:abc')
    expect(getApplied(fixture.projectId, 'tasks', 'task-A')).toBe('sha256:abc')
  })

  test('recordApplied UPSERT replaces hash on subsequent call (no duplicate row)', () => {
    recordApplied(fixture.projectId, 'tasks', 'task-A', 'sha256:v1')
    recordApplied(fixture.projectId, 'tasks', 'task-A', 'sha256:v2')
    expect(getApplied(fixture.projectId, 'tasks', 'task-A')).toBe('sha256:v2')

    const rows = prjctDb.query<{ n: number }>(
      fixture.projectId,
      "SELECT COUNT(*) AS n FROM sync_applied_hashes WHERE entity_type='tasks' AND entity_id='task-A'"
    )
    expect(rows[0]?.n).toBe(1)
  })

  test('getApplied scopes by (entity_type, entity_id) — same id, different type are distinct', () => {
    recordApplied(fixture.projectId, 'tasks', 'shared-id', 'sha256:task')
    recordApplied(fixture.projectId, 'ideas', 'shared-id', 'sha256:idea')

    expect(getApplied(fixture.projectId, 'tasks', 'shared-id')).toBe('sha256:task')
    expect(getApplied(fixture.projectId, 'ideas', 'shared-id')).toBe('sha256:idea')
  })

  test('empty inputs are no-ops (no row written, no exception)', () => {
    recordApplied(fixture.projectId, '', 'task-A', 'sha256:x')
    recordApplied(fixture.projectId, 'tasks', '', 'sha256:x')
    recordApplied(fixture.projectId, 'tasks', 'task-A', '')
    expect(getApplied(fixture.projectId, '', 'task-A')).toBeNull()
    expect(getApplied(fixture.projectId, 'tasks', '')).toBeNull()

    const rows = prjctDb.query<{ n: number }>(
      fixture.projectId,
      'SELECT COUNT(*) AS n FROM sync_applied_hashes'
    )
    expect(rows[0]?.n).toBe(0)
  })

  test('clearApplied drops the row (tombstone path)', () => {
    recordApplied(fixture.projectId, 'tasks', 'task-A', 'sha256:abc')
    expect(getApplied(fixture.projectId, 'tasks', 'task-A')).toBe('sha256:abc')

    clearApplied(fixture.projectId, 'tasks', 'task-A')
    expect(getApplied(fixture.projectId, 'tasks', 'task-A')).toBeNull()
  })

  test('clearApplied is a no-op when no row exists (idempotent)', () => {
    clearApplied(fixture.projectId, 'tasks', 'never-existed')
    expect(getApplied(fixture.projectId, 'tasks', 'never-existed')).toBeNull()
  })

  test('clearApplied with empty inputs is a guarded no-op', () => {
    recordApplied(fixture.projectId, 'tasks', 'task-A', 'sha256:abc')
    clearApplied(fixture.projectId, '', 'task-A')
    clearApplied(fixture.projectId, 'tasks', '')
    // Original row still there.
    expect(getApplied(fixture.projectId, 'tasks', 'task-A')).toBe('sha256:abc')
  })
})
