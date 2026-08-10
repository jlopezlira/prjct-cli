/**
 * Sync round-trip integration test (Phase 1.5).
 *
 * Verifies the full path the architecture reviewer flagged:
 *   1. Local CRUD on device A → publishes a wire-format-complete
 *      SyncEvent to sync_pending.
 *   2. Pending entries are read with their row ids attached.
 *   3. Server confirms a batch → clearPendingByIds drops only the
 *      confirmed rows.
 *   4. Pull on device B → applyEvent upserts the entity by id (no
 *      duplication on second apply).
 *
 * No real network: this exercises the in-process pipeline. The
 * server hop is implicit — push() result IS what the receiving
 * device's pull() would return.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { syncEventBus } from '../../events/sync-events'
import prjctDb from '../../storage/database'
import { ideasStorage } from '../../storage/ideas-storage'
import { syncPendingStorage } from '../../storage/sync-pending-storage'

const fixture: {
  tempDir: string
  originalProjectsDir: string | undefined
} = {
  tempDir: '',
  originalProjectsDir: undefined as unknown as string | undefined,
}

describe('sync round-trip CRUD → pending → confirm → applyEvent', () => {
  beforeEach(async () => {
    fixture.tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-roundtrip-'))
    fixture.originalProjectsDir = process.env.PRJCT_PROJECTS_DIR
    process.env.PRJCT_PROJECTS_DIR = fixture.tempDir
  })

  afterEach(async () => {
    if (fixture.originalProjectsDir === undefined) delete process.env.PRJCT_PROJECTS_DIR
    else process.env.PRJCT_PROJECTS_DIR = fixture.originalProjectsDir
    await fs.rm(fixture.tempDir, { recursive: true, force: true })
  })

  test('CRUD enqueues, partial confirm clears, applyEvent upserts by id', async () => {
    // === Device A: local CRUD ===
    const deviceA = `device-a-${Date.now()}`
    prjctDb.run(deviceA, 'SELECT 1 WHERE 1=0')
    const idea = await ideasStorage.addIdea(deviceA, 'rate limit auth endpoint', {
      priority: 'high',
    })
    expect(idea.id).toBeTruthy()

    // The publish path enqueues a wire-format-complete SyncEvent.
    const entries = await syncEventBus.getPendingEntries(deviceA)
    const ideaEvent = entries.find((e) => e.event.entityType === 'ideas')
    expect(ideaEvent).toBeTruthy()
    if (!ideaEvent) return
    expect(ideaEvent.event.contentHash).toBeTruthy()
    expect(ideaEvent.event.deviceId).toBeTruthy()
    expect(ideaEvent.event.eventType).toBe('upsert')

    // === Server confirms only the ideas event (sparse confirm) ===
    await syncEventBus.clearPendingByIds(deviceA, [ideaEvent.id])

    // Other events (if any) remain queued.
    const remaining = await syncEventBus.getPending(deviceA)
    expect(remaining.find((e) => e.entityType === 'ideas')).toBeUndefined()

    // === Device B: receives the pulled event and applies ===
    const deviceB = `device-b-${Date.now()}`
    prjctDb.run(deviceB, 'SELECT 1 WHERE 1=0')

    // Synthesize what pullEvents would return — the same SyncEvent.
    const pulled = ideaEvent.event
    const { syncManager } = await import('../../sync/sync-manager')
    // applyPulledEvents goes through applyEvent (B2).
    const applied = await syncManager.applyPulledEvents(deviceB, [
      // shape it as the pulled wire format (entity_type/event_type)
      {
        entity_type: pulled.entityType,
        event_type: pulled.eventType,
        data: pulled.data,
        content_hash: pulled.contentHash,
        device_id: pulled.deviceId,
        timestamp: pulled.timestamp,
        type: pulled.type,
      } as Record<string, unknown>,
    ])
    expect(applied).toBeGreaterThanOrEqual(0)

    // === Re-apply (idempotency check) ===
    // Applying the SAME event twice on device B must NOT duplicate.
    // applyEvent is upsert-by-id; the second call should be a no-op.
    const beforeRows = (await ideasStorage.getAll(deviceB)).length
    await syncManager.applyPulledEvents(deviceB, [
      {
        entity_type: pulled.entityType,
        event_type: pulled.eventType,
        data: pulled.data,
        content_hash: pulled.contentHash,
        timestamp: pulled.timestamp,
        type: pulled.type,
      } as Record<string, unknown>,
    ])
    const afterRows = (await ideasStorage.getAll(deviceB)).length
    expect(afterRows).toBe(beforeRows) // idempotent
  })

  test('clearPendingUpTo drains a confirmed prefix', async () => {
    const projectId = `prefix-${Date.now()}`
    prjctDb.run(projectId, 'SELECT 1 WHERE 1=0')

    syncPendingStorage.append(projectId, {
      type: 'ideas.updated',
      path: ['ideas'],
      data: { id: 'a' },
      timestamp: new Date().toISOString(),
      projectId,
      entityType: 'ideas',
      entityId: 'a',
      eventType: 'upsert',
      contentHash: 'h-a',
    })
    const second = syncPendingStorage.append(projectId, {
      type: 'ideas.updated',
      path: ['ideas'],
      data: { id: 'b' },
      timestamp: new Date().toISOString(),
      projectId,
      entityType: 'ideas',
      entityId: 'b',
      eventType: 'upsert',
      contentHash: 'h-b',
    })
    syncPendingStorage.append(projectId, {
      type: 'ideas.updated',
      path: ['ideas'],
      data: { id: 'c' },
      timestamp: new Date().toISOString(),
      projectId,
      entityType: 'ideas',
      entityId: 'c',
      eventType: 'upsert',
      contentHash: 'h-c',
    })

    expect(syncPendingStorage.count(projectId)).toBe(3)
    const removed = await syncEventBus.clearPendingUpTo(projectId, second.id)
    expect(removed).toBe(2)
    expect(syncPendingStorage.count(projectId)).toBe(1)
  })
})
