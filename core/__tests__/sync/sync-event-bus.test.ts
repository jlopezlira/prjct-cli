/**
 * SyncEventBus tests — Phase 1.5 / B3.
 *
 * The bus moved from `sync/pending.json` (racy, JSON file) to a
 * SQLite-backed `sync_pending` table. The legacy "recovers when JSON
 * is malformed" tests don't apply anymore — corrupt-payload rows are
 * dropped at deserialize time inside `sync-pending-storage`. These
 * tests exercise the new contract end-to-end through the bus surface:
 *   - publish + getPending round-trip a SyncEvent
 *   - clearPending drains the queue
 *   - parallel publishes preserve every event (concurrency safety)
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { syncEventBus } from '../../events/sync-events'
import prjctDb from '../../storage/database'
import type { SyncEvent } from '../../types/events'

const fixture: {
  projectId: string
  tempProjectsDir: string
  originalProjectsDir: string | undefined
} = {
  projectId: '',
  tempProjectsDir: '',
  originalProjectsDir: undefined as unknown as string | undefined,
}

function makeEvent(type: string, overrides: Partial<SyncEvent> = {}): SyncEvent {
  return {
    type,
    path: ['queue'],
    data: {},
    timestamp: '2026-04-17T00:00:00Z',
    projectId: fixture.projectId,
    ...overrides,
  }
}

describe('SyncEventBus.publish', () => {
  beforeEach(async () => {
    fixture.tempProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-sync-event-bus-'))
    fixture.originalProjectsDir = process.env.PRJCT_PROJECTS_DIR
    process.env.PRJCT_PROJECTS_DIR = fixture.tempProjectsDir
    fixture.projectId = `sync-event-bus-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    // Trigger migrations
    prjctDb.run(fixture.projectId, 'SELECT 1 WHERE 1=0')
  })

  afterEach(async () => {
    if (fixture.originalProjectsDir === undefined) delete process.env.PRJCT_PROJECTS_DIR
    else process.env.PRJCT_PROJECTS_DIR = fixture.originalProjectsDir
    await fs.rm(fixture.tempProjectsDir, { recursive: true, force: true })
  })

  it('round-trips a published event through getPending', async () => {
    await syncEventBus.publish(makeEvent('queue.task_added'))
    const pending = await syncEventBus.getPending(fixture.projectId)
    expect(pending).toHaveLength(1)
    expect(pending[0].type).toBe('queue.task_added')
  })

  it('clearPending drains the queue', async () => {
    await syncEventBus.publish(makeEvent('queue.task_added'))
    await syncEventBus.publish(makeEvent('queue.task_removed'))
    expect((await syncEventBus.getPending(fixture.projectId)).length).toBe(2)

    await syncEventBus.clearPending(fixture.projectId)
    expect(await syncEventBus.getPending(fixture.projectId)).toEqual([])
  })

  it('parallel publishes do not lose events', async () => {
    const N = 25
    await Promise.all(
      Array.from({ length: N }).map((_, i) =>
        syncEventBus.publish(
          makeEvent('queue.task_added', {
            entityType: 'queue_tasks',
            entityId: `t${i}`,
            contentHash: `h${i}`,
          })
        )
      )
    )
    const pending = await syncEventBus.getPending(fixture.projectId)
    expect(pending.length).toBe(N)
  })
})
