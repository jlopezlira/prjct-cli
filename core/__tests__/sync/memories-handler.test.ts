/**
 * Memories entity handler — the highest-value cross-device entity and the one
 * the old wire silently dropped. These pin:
 *  - upsert writes BOTH the events row (source of truth) and the FTS mirror
 *  - identity/idempotency is by (content_hash, type): re-apply is a no-op
 *  - NO echo: applying a pulled memory must not enqueue a sync event
 *  - delete tombstones by content identity
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import prjctDb from '../../storage/database'
import { syncPendingStorage } from '../../storage/sync-pending-storage'
import { memoriesHandler } from '../../sync/entity-handlers/memories'

const fixture: {
  tempDir: string
  originalProjectsDir: string | undefined
  projectId: string
} = {
  tempDir: '',
  originalProjectsDir: undefined as unknown as string | undefined,
  projectId: '',
}

function memoryRows(): Array<{
  id: string
  type: string
  content_hash: string
  deleted_at: string | null
}> {
  return prjctDb.query(
    fixture.projectId,
    'SELECT id, type, content_hash, deleted_at FROM memory_entries ORDER BY id'
  )
}

function rememberEventCount(): number {
  const row = prjctDb.get<{ cnt: number }>(
    fixture.projectId,
    "SELECT COUNT(*) as cnt FROM events WHERE type LIKE 'memory.remember.%'"
  )
  return row?.cnt ?? 0
}

describe('memories entity handler', () => {
  beforeEach(async () => {
    fixture.tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-mem-handler-'))
    fixture.originalProjectsDir = process.env.PRJCT_PROJECTS_DIR
    process.env.PRJCT_PROJECTS_DIR = fixture.tempDir
    fixture.projectId = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    // Touch the DB so the schema (events + memories + sync_pending) exists.
    prjctDb.run(fixture.projectId, 'SELECT 1 WHERE 1=0')
  })

  afterEach(async () => {
    if (fixture.originalProjectsDir === undefined) delete process.env.PRJCT_PROJECTS_DIR
    else process.env.PRJCT_PROJECTS_DIR = fixture.originalProjectsDir
    await fs.rm(fixture.tempDir, { recursive: true, force: true })
  })

  test('upsert writes an events row + an FTS mirror row', async () => {
    await memoriesHandler.upsert(fixture.projectId, {
      id: 'mem-x',
      type: 'decision',
      content: 'use the unified entity map',
      tags: { topic: 'sync' },
      provenance: 'declared',
    })

    expect(rememberEventCount()).toBe(1)
    const rows = memoryRows()
    expect(rows.length).toBe(1)
    expect(rows[0].type).toBe('decision')
    expect(rows[0].deleted_at).toBeNull()
  })

  test('re-applying the same (content, type) is idempotent (no duplicate)', async () => {
    const data = { id: 'mem-y', type: 'learning', content: 'cursors beat timestamps' }
    await memoriesHandler.upsert(fixture.projectId, data)
    await memoriesHandler.upsert(fixture.projectId, data)
    await memoriesHandler.upsert(fixture.projectId, { ...data, id: 'different-synced-id' })

    expect(memoryRows().length).toBe(1)
    expect(rememberEventCount()).toBe(1)
  })

  test('does NOT echo — applying a pulled memory enqueues no sync event', async () => {
    const before = syncPendingStorage.list(fixture.projectId).length
    await memoriesHandler.upsert(fixture.projectId, {
      id: 'mem-z',
      type: 'gotcha',
      content: 'pulled memories must not re-publish',
    })
    const after = syncPendingStorage.list(fixture.projectId).length
    expect(after).toBe(before)
  })

  test('delete tombstones by content identity', async () => {
    const data = {
      id: 'remote-id',
      type: 'improvement-signal',
      content: 'skill-miss: generated garbage',
    }
    await memoriesHandler.upsert(fixture.projectId, data)
    expect(memoryRows()[0].deleted_at).toBeNull()

    await memoriesHandler.delete(fixture.projectId, data)
    const rows = prjctDb.query<{ deleted_at: string | null; type: string }>(
      fixture.projectId,
      'SELECT deleted_at, type FROM memory_entries'
    )
    expect(rows[0].deleted_at).not.toBeNull()
    expect(rememberEventCount()).toBe(0)
  })

  test('ignores events missing content or type', async () => {
    await memoriesHandler.upsert(fixture.projectId, { id: 'no-content', type: 'decision' })
    await memoriesHandler.upsert(fixture.projectId, { id: 'no-type', content: 'orphan' })
    expect(memoryRows().length).toBe(0)
  })
})
