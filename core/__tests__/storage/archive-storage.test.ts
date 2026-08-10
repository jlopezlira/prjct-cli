/**
 * Archive Storage Tests (PRJ-267)
 *
 * Tests for the archive infrastructure and archival policies:
 * - Archive table operations (insert, query, restore)
 * - Shipped features archival (>90 days)
 * - Ideas dormancy (>180 days pending)
 * - Queue cleanup (>7 days completed)
 * - Paused task archival (>30 days)
 * - Memory log capping (500 entries)
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'
import { ARCHIVE_POLICIES, archiveStorage } from '../../storage/archive-storage'
import { prjctDb } from '../../storage/database'
import { ideasStorage } from '../../storage/ideas-storage'
import { queueStorage } from '../../storage/queue-storage'
import { shippedStorage } from '../../storage/shipped-storage'
import { stateStorage } from '../../storage/state-storage'
import { getTimestamp } from '../../utils/date-helper'

// Test Setup

const fixture = { tmpRoot: '', testProjectId: '' }

const originalGetGlobalProjectPath = pathManager.getGlobalProjectPath.bind(pathManager)
const originalGetFilePath = pathManager.getFilePath.bind(pathManager)

function daysAgoISO(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString()
}

describe('Archive Storage', () => {
  beforeEach(async () => {
    // A previous test's fire-and-forget publishCRUDSync can land AFTER its
    // afterEach restored the real pathManager — opening a REAL-path
    // connection that stays in prjctDb's cache and hijacks this test's
    // patched paths (rows then accumulate in ~/.prjct-cli across runs and
    // assertions read real counts). Drop any cached connections first so
    // getDb re-resolves through the patch below.
    prjctDb.close()

    fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-archive-test-'))
    fixture.testProjectId = 'test-archive-project'

    pathManager.getGlobalProjectPath = (projectId: string) => path.join(fixture.tmpRoot, projectId)

    pathManager.getFilePath = (projectId: string, layer: string, filename: string) =>
      path.join(fixture.tmpRoot, projectId, layer, filename)

    // Ensure all required dirs exist
    const dirs = ['context', 'memory', 'core', 'progress', 'planning', 'sync']
    await Promise.all(
      dirs.map((d) =>
        fs.mkdir(path.join(fixture.tmpRoot, fixture.testProjectId, d), { recursive: true })
      )
    )

    // Create empty pending.json for event bus
    await fs.writeFile(
      path.join(fixture.tmpRoot, fixture.testProjectId, 'sync', 'pending.json'),
      '[]',
      'utf-8'
    )

    // Initialize the database (triggers migrations including archives table)
    prjctDb.getDb(fixture.testProjectId)
  })

  afterEach(async () => {
    prjctDb.close()
    pathManager.getGlobalProjectPath = originalGetGlobalProjectPath
    pathManager.getFilePath = originalGetFilePath

    if (fixture.tmpRoot) {
      await fs.rm(fixture.tmpRoot, { recursive: true, force: true })
    }
  })

  // Archive Table Operations

  describe('archive table', () => {
    it('should archive a single item', () => {
      const id = archiveStorage.archive(fixture.testProjectId, {
        entityType: 'shipped',
        entityId: 'ship-1',
        entityData: { name: 'Feature A', version: '1.0.0' },
        summary: 'Feature A v1.0.0',
        reason: 'age',
      })

      expect(id).toBeTruthy()

      const records = archiveStorage.getArchived(fixture.testProjectId, 'shipped')
      expect(records).toHaveLength(1)
      expect(records[0].entity_id).toBe('ship-1')
      expect(records[0].summary).toBe('Feature A v1.0.0')
    })

    it('should archive multiple items in a transaction', () => {
      const count = archiveStorage.archiveMany(fixture.testProjectId, [
        { entityType: 'shipped', entityId: 's1', entityData: { a: 1 }, reason: 'age' },
        { entityType: 'shipped', entityId: 's2', entityData: { a: 2 }, reason: 'age' },
        { entityType: 'idea', entityId: 'i1', entityData: { b: 1 }, reason: 'dormant' },
      ])

      expect(count).toBe(3)

      const stats = archiveStorage.getStats(fixture.testProjectId)
      expect(stats.shipped).toBe(2)
      expect(stats.idea).toBe(1)
      expect(stats.total).toBe(3)
    })

    it('should restore an archived item', () => {
      archiveStorage.archive(fixture.testProjectId, {
        entityType: 'shipped',
        entityId: 'ship-1',
        entityData: { name: 'restored' },
        reason: 'age',
      })

      const records = archiveStorage.getArchived(fixture.testProjectId)
      expect(records).toHaveLength(1)

      const data = archiveStorage.restore(fixture.testProjectId, records[0].id)
      expect(data).toEqual({ name: 'restored' })

      // Should be removed from archive
      const after = archiveStorage.getArchived(fixture.testProjectId)
      expect(after).toHaveLength(0)
    })

    it('should prune old archives', () => {
      // Insert an archive with old timestamp
      const db = prjctDb.getDb(fixture.testProjectId)
      const oldDate = daysAgoISO(400)
      db.prepare(
        'INSERT INTO archives (id, entity_type, entity_id, entity_data, archived_at, reason) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('old-1', 'shipped', 's1', '{}', oldDate, 'age')

      archiveStorage.archive(fixture.testProjectId, {
        entityType: 'shipped',
        entityId: 's2',
        entityData: {},
        reason: 'age',
      })

      const pruned = archiveStorage.pruneOldArchives(fixture.testProjectId, 365)
      expect(pruned).toBe(1)

      const remaining = archiveStorage.getArchived(fixture.testProjectId)
      expect(remaining).toHaveLength(1)
      expect(remaining[0].entity_id).toBe('s2')
    })
  })

  // Shipped Features Archival

  describe('shipped archival', () => {
    it('should archive shipped features older than 90 days', async () => {
      // Seed shipped rows (typed store) with old and recent items.
      const recent = await shippedStorage.addShipped(
        fixture.testProjectId,
        { name: 'Recent', version: '2.0.0' },
        daysAgoISO(10)
      )
      const old = await shippedStorage.addShipped(
        fixture.testProjectId,
        { name: 'Old', version: '1.0.0' },
        daysAgoISO(100)
      )

      const archived = await shippedStorage.archiveOldShipped(fixture.testProjectId)
      expect(archived).toBe(1)

      // Verify active storage only has recent
      const data = await shippedStorage.getAll(fixture.testProjectId)
      expect(data).toHaveLength(1)
      expect(data[0].id).toBe(recent.id)

      // Verify archive table has old item
      const records = archiveStorage.getArchived(fixture.testProjectId, 'shipped')
      expect(records).toHaveLength(1)
      expect(records[0].entity_id).toBe(old.id)
      expect(records[0].summary).toBe('Old v1.0.0')
    })

    it('should not archive recent shipped features', async () => {
      await shippedStorage.addShipped(
        fixture.testProjectId,
        { name: 'R1', version: '1.0.0' },
        daysAgoISO(5)
      )
      await shippedStorage.addShipped(
        fixture.testProjectId,
        { name: 'R2', version: '1.1.0' },
        daysAgoISO(30)
      )

      const archived = await shippedStorage.archiveOldShipped(fixture.testProjectId)
      expect(archived).toBe(0)

      const data = await shippedStorage.getAll(fixture.testProjectId)
      expect(data).toHaveLength(2)
    })
  })

  // Ideas Dormancy

  describe('ideas dormancy', () => {
    it('should mark pending ideas older than 180 days as dormant', async () => {
      // Seed typed idea rows: fresh pending, stale pending, converted.
      await ideasStorage.upsertIdea(fixture.testProjectId, {
        id: 'new',
        text: 'New idea',
        status: 'pending',
        priority: 'medium',
        addedAt: daysAgoISO(10),
      })
      await ideasStorage.upsertIdea(fixture.testProjectId, {
        id: 'stale',
        text: 'Stale idea',
        status: 'pending',
        priority: 'low',
        addedAt: daysAgoISO(200),
      })
      await ideasStorage.upsertIdea(fixture.testProjectId, {
        id: 'converted',
        text: 'Converted',
        status: 'converted',
        priority: 'high',
        addedAt: daysAgoISO(300),
      })

      const dormant = await ideasStorage.markDormantIdeas(fixture.testProjectId)
      expect(dormant).toBe(1)

      expect((await ideasStorage.getById(fixture.testProjectId, 'stale'))?.status).toBe('dormant')
      // New idea should remain pending
      expect((await ideasStorage.getById(fixture.testProjectId, 'new'))?.status).toBe('pending')
      // Converted should remain converted
      expect((await ideasStorage.getById(fixture.testProjectId, 'converted'))?.status).toBe(
        'converted'
      )

      // Archive table should have the dormant idea
      const records = archiveStorage.getArchived(fixture.testProjectId, 'idea')
      expect(records).toHaveLength(1)
    })

    it('should track dormant status in SQLite', async () => {
      await ideasStorage.upsertIdea(fixture.testProjectId, {
        id: 'active',
        text: 'Active idea',
        status: 'pending',
        priority: 'medium',
        addedAt: daysAgoISO(5),
      })
      await ideasStorage.upsertIdea(fixture.testProjectId, {
        id: 'dormant',
        text: 'Dormant idea',
        status: 'dormant',
        priority: 'low',
        addedAt: daysAgoISO(200),
      })

      // Read back from storage — dormant ideas preserved in SQLite
      const all = await ideasStorage.getAll(fixture.testProjectId)
      const active = all.filter((i) => i.status === 'pending')
      const dormant = all.filter((i) => i.status === 'dormant')

      expect(active).toHaveLength(1)
      expect(active[0].text).toBe('Active idea')
      expect(dormant).toHaveLength(1)
      expect(dormant[0].text).toBe('Dormant idea')
    })
  })

  // Queue Cleanup

  describe('queue cleanup', () => {
    it('should remove completed tasks older than 7 days', async () => {
      // Seed typed queue rows: one active, one recently-completed, one stale.
      await queueStorage.upsertTask(fixture.testProjectId, {
        id: 'active',
        description: 'Active',
        type: 'feature',
        priority: 'medium',
        section: 'active',
        createdAt: daysAgoISO(1),
        completed: false,
      })
      await queueStorage.upsertTask(fixture.testProjectId, {
        id: 'recent-done',
        description: 'Recent done',
        type: 'feature',
        priority: 'medium',
        section: 'active',
        createdAt: daysAgoISO(5),
        completed: true,
        completedAt: daysAgoISO(2),
      })
      await queueStorage.upsertTask(fixture.testProjectId, {
        id: 'old-done',
        description: 'Old done',
        type: 'feature',
        priority: 'low',
        section: 'active',
        createdAt: daysAgoISO(30),
        completed: true,
        completedAt: daysAgoISO(10),
      })

      const removed = await queueStorage.removeStaleCompleted(fixture.testProjectId)
      expect(removed).toBe(1)

      const remaining = await queueStorage.getTasks(fixture.testProjectId)
      expect(remaining).toHaveLength(2)
      expect(remaining.map((t) => t.id).sort()).toEqual(['active', 'recent-done'])

      // Archive should have the old completed task
      const records = archiveStorage.getArchived(fixture.testProjectId, 'queue_task')
      expect(records).toHaveLength(1)
      expect(records[0].entity_id).toBe('old-done')
    })
  })

  // Paused Task Archival

  describe('paused task archival', () => {
    it('should archive paused tasks older than 30 days', async () => {
      await stateStorage.write(fixture.testProjectId, {
        currentTask: null,
        previousTask: null,
        pausedTasks: [
          {
            id: 'recent',
            description: 'Recent pause',
            status: 'paused',
            startedAt: daysAgoISO(35),
            pausedAt: daysAgoISO(5),
          },
          {
            id: 'stale',
            description: 'Stale pause',
            status: 'paused',
            startedAt: daysAgoISO(60),
            pausedAt: daysAgoISO(40),
          },
        ],
        lastUpdated: getTimestamp(),
      })

      const archived = await stateStorage.archiveStalePausedTasks(fixture.testProjectId)
      expect(archived).toHaveLength(1)
      expect(archived[0].id).toBe('stale')

      // Active state should only have recent
      const state = await stateStorage.read(fixture.testProjectId)
      expect(state.pausedTasks).toHaveLength(1)
      expect(state.pausedTasks![0].id).toBe('recent')

      // Archive table should have stale
      const records = archiveStorage.getArchived(fixture.testProjectId, 'paused_task')
      expect(records).toHaveLength(1)
      expect(records[0].entity_id).toBe('stale')
    })
  })

  // Memory Log Capping

  describe('memory log capping', () => {
    it('should cap memory entries at max limit', async () => {
      // Write more entries than the limit to SQLite events table
      const total = ARCHIVE_POLICIES.MEMORY_MAX_ENTRIES + 50
      for (const i of Array.from({ length: total }, (_, index) => index)) {
        prjctDb.appendEvent(fixture.testProjectId, `memory.action-${i}`, {
          action: `action-${i}`,
          index: i,
        })
      }

      // Import and use memoryService
      const { memoryService } = await import('../../services/memory-service')
      const capped = await memoryService.capEntries(fixture.testProjectId)
      expect(capped).toBe(50)

      // SQLite should now have exactly max entries
      const countRow = prjctDb.get<{ cnt: number }>(
        fixture.testProjectId,
        "SELECT COUNT(*) as cnt FROM events WHERE type LIKE 'memory.%'"
      )
      expect(countRow!.cnt).toBe(ARCHIVE_POLICIES.MEMORY_MAX_ENTRIES)

      // Archive should have the overflow
      const records = archiveStorage.getArchived(fixture.testProjectId, 'memory_entry')
      expect(records).toHaveLength(50)
    })

    it('NEVER deletes memory.remember.* knowledge, regardless of age or volume', async () => {
      // The real-world incident: hundreds of memory.post_edit telemetry
      // rows pushed the combined count past the cap, and the age-ordered
      // delete destroyed the OLDEST remembered decisions/gotchas while
      // keeping newer telemetry. Knowledge must be invisible to the cap
      // (both the count and the delete) — it leaves via `prjct forget`.
      for (const i of Array.from({ length: 30 }, (_, index) => index)) {
        prjctDb.appendEvent(fixture.testProjectId, 'memory.remember.decision', {
          content: `old precious decision ${i}`,
          tags: {},
        })
      }
      const total = ARCHIVE_POLICIES.MEMORY_MAX_ENTRIES + 20
      for (const i2 of Array.from({ length: total }, (_, index) => index)) {
        prjctDb.appendEvent(fixture.testProjectId, 'memory.post_edit', {
          file: `f${i2}.ts`,
        })
      }

      const { memoryService } = await import('../../services/memory-service')
      const capped = await memoryService.capEntries(fixture.testProjectId)
      expect(capped).toBe(20)

      // Every remember row survives — even though they are the oldest.
      const remembered = prjctDb.get<{ cnt: number }>(
        fixture.testProjectId,
        "SELECT COUNT(*) as cnt FROM events WHERE type LIKE 'memory.remember.%'"
      )
      expect(remembered!.cnt).toBe(30)

      // Telemetry got capped to the limit.
      const telemetry = prjctDb.get<{ cnt: number }>(
        fixture.testProjectId,
        "SELECT COUNT(*) as cnt FROM events WHERE type LIKE 'memory.%' AND type NOT LIKE 'memory.remember.%'"
      )
      expect(telemetry!.cnt).toBe(ARCHIVE_POLICIES.MEMORY_MAX_ENTRIES)
    })

    it('should not cap if under limit', async () => {
      // Write a few entries under the limit to SQLite
      for (const i of Array.from({ length: 10 }, (_, index) => index)) {
        prjctDb.appendEvent(fixture.testProjectId, `memory.a-${i}`, {
          action: `a-${i}`,
          data: {},
        })
      }

      const { memoryService } = await import('../../services/memory-service')
      const capped = await memoryService.capEntries(fixture.testProjectId)
      expect(capped).toBe(0)
    })
  })

  // Archive Policies Constants

  describe('archive policies', () => {
    it('should have correct default policy values', () => {
      expect(ARCHIVE_POLICIES.SHIPPED_RETENTION_DAYS).toBe(90)
      expect(ARCHIVE_POLICIES.IDEA_DORMANT_DAYS).toBe(180)
      expect(ARCHIVE_POLICIES.QUEUE_COMPLETED_DAYS).toBe(7)
      expect(ARCHIVE_POLICIES.PAUSED_TASK_DAYS).toBe(30)
      expect(ARCHIVE_POLICIES.MEMORY_MAX_ENTRIES).toBe(500)
    })
  })
})
