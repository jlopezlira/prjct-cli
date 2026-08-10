/**
 * sync-pending-storage tests — verify B3 properties:
 *   - append/list/clear are SQLite-backed
 *   - dedupe by (entity_type, entity_id, content_hash) keeps the queue
 *     bounded under retry storms
 *   - clearUpTo handles partial server confirms without losing
 *     unconfirmed events
 *   - parallel appends preserve every row (concurrency safety)
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import prjctDb from '../../storage/database'
import { syncPendingStorage } from '../../storage/sync-pending-storage'
import type { SyncEvent } from '../../types/events'

const fixture: {
  PROJECT: string
  tempProjectsDir: string
  originalProjectsDir: string | undefined
} = {
  PROJECT: 'sync-pending-test',
  tempProjectsDir: '',
  originalProjectsDir: undefined as unknown as string | undefined,
}

function makeEvent(overrides: Partial<SyncEvent> = {}): SyncEvent {
  return {
    type: 'tasks.upsert',
    path: ['tasks'],
    data: { foo: 'bar' },
    timestamp: new Date().toISOString(),
    projectId: fixture.PROJECT,
    entityType: 'tasks',
    entityId: 'task-1',
    eventType: 'upsert',
    contentHash: 'hash-1',
    deviceId: 'device-1',
    revisionCount: 1,
    ...overrides,
  }
}

describe('sync-pending-storage', () => {
  beforeEach(async () => {
    fixture.tempProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-pending-test-'))
    fixture.originalProjectsDir = process.env.PRJCT_PROJECTS_DIR
    process.env.PRJCT_PROJECTS_DIR = fixture.tempProjectsDir
    // Per-test project id so each test runs against a fresh DB.
    fixture.PROJECT = `sync-pending-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    // Trigger migrations
    prjctDb.run(fixture.PROJECT, 'SELECT 1 WHERE 1=0')
  })

  afterEach(async () => {
    if (fixture.originalProjectsDir === undefined) delete process.env.PRJCT_PROJECTS_DIR
    else process.env.PRJCT_PROJECTS_DIR = fixture.originalProjectsDir
    await fs.rm(fixture.tempProjectsDir, { recursive: true, force: true })
  })

  test('append + list round-trips a SyncEvent', () => {
    const ev = makeEvent({ data: { description: 'first' } })
    const entry = syncPendingStorage.append(fixture.PROJECT, ev)
    expect(entry.id).toBeGreaterThan(0)

    const out = syncPendingStorage.list(fixture.PROJECT)
    expect(out).toHaveLength(1)
    expect(out[0].event.type).toBe('tasks.upsert')
    expect((out[0].event.data as { description: string }).description).toBe('first')
    expect(out[0].event.contentHash).toBe('hash-1')
  })

  test('dedupes by (entity_type, entity_id, content_hash)', () => {
    // Same entity + same hash → second append supersedes the first.
    syncPendingStorage.append(fixture.PROJECT, makeEvent({ data: { v: 1 } }))
    syncPendingStorage.append(fixture.PROJECT, makeEvent({ data: { v: 1 } }))
    syncPendingStorage.append(fixture.PROJECT, makeEvent({ data: { v: 1 } }))

    expect(syncPendingStorage.count(fixture.PROJECT)).toBe(1)
  })

  test('different content_hash for same entity = NEW pending row (real edit)', () => {
    syncPendingStorage.append(fixture.PROJECT, makeEvent({ contentHash: 'hash-A' }))
    syncPendingStorage.append(fixture.PROJECT, makeEvent({ contentHash: 'hash-B' }))

    const all = syncPendingStorage.list(fixture.PROJECT)
    expect(all).toHaveLength(2)
    expect(all.map((e) => e.event.contentHash)).toEqual(['hash-A', 'hash-B'])
  })

  test('legacy events without entityType/entityId are not deduped', () => {
    // Before B1 instrumentation, events from other code paths might
    // lack identity. Queue should not collapse them.
    const legacy: SyncEvent = {
      type: 'task.updated',
      path: ['task'],
      data: { id: 'a' },
      timestamp: new Date().toISOString(),
      projectId: fixture.PROJECT,
    }
    syncPendingStorage.append(fixture.PROJECT, legacy)
    syncPendingStorage.append(fixture.PROJECT, legacy)
    syncPendingStorage.append(fixture.PROJECT, legacy)
    expect(syncPendingStorage.count(fixture.PROJECT)).toBe(3)
  })

  test('clearUpTo removes a confirmed prefix and leaves the rest', () => {
    const a = syncPendingStorage.append(fixture.PROJECT, makeEvent({ entityId: 'a' }))
    const b = syncPendingStorage.append(fixture.PROJECT, makeEvent({ entityId: 'b' }))
    const _c = syncPendingStorage.append(fixture.PROJECT, makeEvent({ entityId: 'c' }))

    const removed = syncPendingStorage.clearUpTo(fixture.PROJECT, b.id)
    expect(removed).toBe(2)

    const remaining = syncPendingStorage.list(fixture.PROJECT)
    expect(remaining).toHaveLength(1)
    expect(remaining[0].id).toBeGreaterThan(a.id)
  })

  test('clearByIds drops specific rows for sparse confirms', () => {
    const a = syncPendingStorage.append(fixture.PROJECT, makeEvent({ entityId: 'a' }))
    const _b = syncPendingStorage.append(fixture.PROJECT, makeEvent({ entityId: 'b' }))
    const c = syncPendingStorage.append(fixture.PROJECT, makeEvent({ entityId: 'c' }))

    syncPendingStorage.clearByIds(fixture.PROJECT, [a.id, c.id])

    const remaining = syncPendingStorage.list(fixture.PROJECT)
    expect(remaining.map((e) => e.event.entityId ?? 'x')).toEqual(['b'])
  })

  test('parallel appends do not lose rows', async () => {
    const N = 50
    await Promise.all(
      Array.from({ length: N }).map((_, i) =>
        Promise.resolve().then(() =>
          syncPendingStorage.append(
            fixture.PROJECT,
            makeEvent({ entityId: `e${i}`, contentHash: `h${i}` })
          )
        )
      )
    )
    expect(syncPendingStorage.count(fixture.PROJECT)).toBe(N)
  })

  test('clearAll empties the queue', () => {
    for (const i of Array.from({ length: 5 }, (_, index) => index)) {
      syncPendingStorage.append(
        fixture.PROJECT,
        makeEvent({ entityId: `e${i}`, contentHash: `h${i}` })
      )
    }
    expect(syncPendingStorage.count(fixture.PROJECT)).toBe(5)
    syncPendingStorage.clearAll(fixture.PROJECT)
    expect(syncPendingStorage.count(fixture.PROJECT)).toBe(0)
  })
})
