/**
 * Storage Manager Tests
 *
 * Tests for the base StorageManager class:
 * - Read/write JSON operations
 * - Missing file handling
 * - Directory creation
 * - Cache behavior
 * - State consistency
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'
import { prjctDb } from '../../storage/database'
import { StorageManager } from '../../storage/storage-manager'

// Test Implementation

interface TestData {
  value: string
  count: number
  items: string[]
}

/**
 * Concrete implementation for testing the abstract StorageManager
 */
class TestStorageManager extends StorageManager<TestData> {
  constructor() {
    super('test-data.json')
  }

  protected getDefault(): TestData {
    return { value: '', count: 0, items: [] }
  }

  protected getEventType(action: 'update' | 'create' | 'delete'): string {
    return `test.${action}`
  }
}

// Test Setup

const fixture: {
  tmpRoot: string | null
  testProjectId: string
  manager: TestStorageManager
} = {
  tmpRoot: null,
  testProjectId: '',
  manager: undefined as unknown as TestStorageManager,
}

// Mock pathManager to use temp directory
const originalGetGlobalProjectPath = pathManager.getGlobalProjectPath.bind(pathManager)
const originalGetStoragePath = pathManager.getStoragePath.bind(pathManager)
const originalGetFilePath = pathManager.getFilePath.bind(pathManager)

describe('StorageManager', () => {
  beforeEach(async () => {
    // Create temp directory for test isolation
    fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-storage-test-'))
    fixture.testProjectId = 'test-project-123'

    // Mock pathManager to use temp directory
    pathManager.getGlobalProjectPath = (projectId: string) => {
      return path.join(fixture.tmpRoot!, projectId)
    }

    pathManager.getStoragePath = (projectId: string, filename: string) => {
      return path.join(fixture.tmpRoot!, projectId, 'storage', filename)
    }

    pathManager.getFilePath = (projectId: string, layer: string, filename: string) => {
      return path.join(fixture.tmpRoot!, projectId, layer, filename)
    }

    // Create fresh manager instance
    fixture.manager = new TestStorageManager()
  })

  afterEach(async () => {
    // Close SQLite connections before cleanup
    prjctDb.close()

    // Restore original pathManager methods
    pathManager.getGlobalProjectPath = originalGetGlobalProjectPath
    pathManager.getStoragePath = originalGetStoragePath
    pathManager.getFilePath = originalGetFilePath

    // Clean up temp directory
    if (fixture.tmpRoot) {
      await fs.rm(fixture.tmpRoot, { recursive: true, force: true })
      fixture.tmpRoot = null
    }
  })

  // Read/Write Tests

  describe('read/write', () => {
    it('should write and read JSON correctly', async () => {
      const testData: TestData = {
        value: 'hello',
        count: 42,
        items: ['a', 'b', 'c'],
      }

      await fixture.manager.write(fixture.testProjectId, testData)
      const result = await fixture.manager.read(fixture.testProjectId)

      expect(result).toEqual(testData)
    })

    it('should write to SQLite kv_store', async () => {
      const testData: TestData = {
        value: 'test',
        count: 1,
        items: ['item1'],
      }

      await fixture.manager.write(fixture.testProjectId, testData)

      // Verify SQLite has the data
      const doc = prjctDb.getDoc<TestData>(fixture.testProjectId, 'test-data')
      expect(doc).toEqual(testData)
    })

    it('should not create JSON storage file', async () => {
      const testData: TestData = {
        value: 'test',
        count: 1,
        items: ['item1'],
      }

      await fixture.manager.write(fixture.testProjectId, testData)

      // Verify JSON file does NOT exist
      const storagePath = path.join(
        fixture.tmpRoot!,
        fixture.testProjectId,
        'storage',
        'test-data.json'
      )
      await expect(fs.access(storagePath)).rejects.toThrow()
    })

    it('should overwrite existing data', async () => {
      const data1: TestData = { value: 'first', count: 1, items: [] }
      const data2: TestData = { value: 'second', count: 2, items: ['new'] }

      await fixture.manager.write(fixture.testProjectId, data1)
      await fixture.manager.write(fixture.testProjectId, data2)

      const result = await fixture.manager.read(fixture.testProjectId)
      expect(result).toEqual(data2)
    })
  })

  // Missing File Handling

  describe('missing file handling', () => {
    it('should return default when file does not exist', async () => {
      const result = await fixture.manager.read('non-existent-project')

      expect(result).toEqual({ value: '', count: 0, items: [] })
    })

    it('should report exists=false when no data', async () => {
      const exists = await fixture.manager.exists('non-existent-project')
      expect(exists).toBe(false)
    })

    it('should report exists=true after write', async () => {
      await fixture.manager.write(fixture.testProjectId, { value: 'test', count: 1, items: [] })

      const exists = await fixture.manager.exists(fixture.testProjectId)
      expect(exists).toBe(true)
    })
  })

  // Directory Creation

  describe('directory creation', () => {
    it('should create project directory for SQLite DB', async () => {
      const testData: TestData = { value: 'dir-test', count: 1, items: [] }

      // Project directory shouldn't exist yet
      const projectDir = path.join(fixture.tmpRoot!, fixture.testProjectId)
      await expect(fs.access(projectDir)).rejects.toThrow()

      // Write should create it (SQLite DB creates its parent dir)
      await fixture.manager.write(fixture.testProjectId, testData)

      // Project dir should exist (created by SQLite)
      const stat = await fs.stat(projectDir)
      expect(stat.isDirectory()).toBe(true)
    })

    it('should create nested directories', async () => {
      const deepProjectId = 'deep/nested/project'
      const testData: TestData = { value: 'nested', count: 1, items: [] }

      await fixture.manager.write(deepProjectId, testData)

      const result = await fixture.manager.read(deepProjectId)
      expect(result).toEqual(testData)
    })
  })

  // Cache Behavior

  describe('cache behavior', () => {
    // `read` caches only OUTSIDE the daemon (storage-manager.ts): the daemon is
    // long-lived, so its cache can serve a value a concurrent CLI already
    // overwrote. Both modes are pinned below, and the ambient value is
    // neutralised — otherwise the suite fails whenever it runs as a child of
    // the daemon, which is exactly how `prjct ship` runs its Stop-Slop gate.
    const daemonEnv: { previous: string | undefined } = { previous: undefined }

    beforeEach(() => {
      daemonEnv.previous = process.env.PRJCT_IN_DAEMON
      delete process.env.PRJCT_IN_DAEMON
    })

    afterEach(() => {
      if (daemonEnv.previous === undefined) delete process.env.PRJCT_IN_DAEMON
      else process.env.PRJCT_IN_DAEMON = daemonEnv.previous
    })

    it('should cache read results', async () => {
      const testData: TestData = { value: 'cached', count: 1, items: [] }
      await fixture.manager.write(fixture.testProjectId, testData)

      // First read
      const result1 = await fixture.manager.read(fixture.testProjectId)

      // Modify SQLite directly (bypass manager)
      prjctDb.setDoc(fixture.testProjectId, 'test-data', { value: 'modified', count: 2, items: [] })

      // Second read should return cached value
      const result2 = await fixture.manager.read(fixture.testProjectId)
      expect(result2).toEqual(result1)
    })

    it('reads through the cache inside the daemon — SQLite is the source of truth', async () => {
      const testData: TestData = { value: 'cached', count: 1, items: [] }
      await fixture.manager.write(fixture.testProjectId, testData)
      await fixture.manager.read(fixture.testProjectId)

      // A concurrent CLI process overwrites the row the daemon has cached.
      prjctDb.setDoc(fixture.testProjectId, 'test-data', { value: 'modified', count: 2, items: [] })

      process.env.PRJCT_IN_DAEMON = '1'
      const fresh = await fixture.manager.read(fixture.testProjectId)
      expect(fresh).toEqual({ value: 'modified', count: 2, items: [] })
    })

    it('should clear cache for specific project', async () => {
      const testData: TestData = { value: 'to-clear', count: 1, items: [] }
      await fixture.manager.write(fixture.testProjectId, testData)

      // Read to populate cache
      await fixture.manager.read(fixture.testProjectId)

      // Write new data through the manager (the proper API)
      const newData: TestData = { value: 'updated', count: 99, items: ['new'] }
      await fixture.manager.write(fixture.testProjectId, newData)

      // Create a new manager instance (simulates fresh session without cache)
      const freshManager = new TestStorageManager()

      // Clear cache on original manager
      fixture.manager.clearCache(fixture.testProjectId)

      // Both should get the new data
      const result = await fixture.manager.read(fixture.testProjectId)
      expect(result).toEqual(newData)

      const freshResult = await freshManager.read(fixture.testProjectId)
      expect(freshResult).toEqual(newData)
    })

    it('should clear all cache', async () => {
      // Write to multiple projects
      await fixture.manager.write('project-a', { value: 'a', count: 1, items: [] })
      await fixture.manager.write('project-b', { value: 'b', count: 2, items: [] })

      // Read to populate cache
      await fixture.manager.read('project-a')
      await fixture.manager.read('project-b')

      // Clear all cache
      fixture.manager.clearCache()

      // Verify cache stats
      const stats = fixture.manager.getCacheStats()
      expect(stats.size).toBe(0)
    })

    it('should return cache stats', async () => {
      const stats = fixture.manager.getCacheStats()

      expect(stats).toHaveProperty('size')
      expect(stats).toHaveProperty('maxSize')
      expect(stats).toHaveProperty('ttl')
      expect(typeof stats.size).toBe('number')
      expect(typeof stats.maxSize).toBe('number')
      expect(typeof stats.ttl).toBe('number')
    })
  })

  // State Consistency (Update Operations)

  describe('state consistency', () => {
    it('should update data atomically with updater function', async () => {
      const initial: TestData = { value: 'initial', count: 0, items: [] }
      await fixture.manager.write(fixture.testProjectId, initial)

      const result = await fixture.manager.update(fixture.testProjectId, (current) => ({
        ...current,
        count: current.count + 1,
        items: [...current.items, 'new-item'],
      }))

      expect(result.count).toBe(1)
      expect(result.items).toEqual(['new-item'])

      // Verify persisted
      fixture.manager.clearCache(fixture.testProjectId)
      const persisted = await fixture.manager.read(fixture.testProjectId)
      expect(persisted).toEqual(result)
    })

    it('casSetDoc rejects a stale write (lost-update guard)', async () => {
      await fixture.manager.write(fixture.testProjectId, { value: 'v0', count: 0, items: [] })
      const key = 'test-data' // getStoreKey() strips '.json' from the filename

      // Reader A snapshots the row + its stamp.
      const a = prjctDb.getDocWithStamp<TestData>(fixture.testProjectId, key)
      expect(a).not.toBeNull()

      // Writer B commits first against that same stamp → succeeds.
      const bOk = prjctDb.casSetDoc(
        fixture.testProjectId,
        key,
        { value: 'B', count: 1, items: [] },
        a?.updatedAt ?? null
      )
      expect(bOk).toBe(true)

      // Writer A now tries to write against the now-stale stamp. Without
      // CAS this blind-overwrites B (B's update lost). It MUST be rejected.
      const aOk = prjctDb.casSetDoc(
        fixture.testProjectId,
        key,
        { value: 'A', count: 0, items: [] },
        a?.updatedAt ?? null
      )
      expect(aOk).toBe(false)

      const final = prjctDb.getDocWithStamp<TestData>(fixture.testProjectId, key)
      expect(final?.data.value).toBe('B') // B survived; A did not clobber it
    })

    it('concurrent update() calls do not lose each other (no lost update)', async () => {
      await fixture.manager.write(fixture.testProjectId, { value: 'seed', count: 0, items: [] })

      // 12 concurrent updaters each appending a distinct item. The old
      // read→transform→write blind-overwrote; CAS-retry must land all 12.
      const N = 12
      await Promise.all(
        Array.from({ length: N }, (_, i) =>
          fixture.manager.update(fixture.testProjectId, (cur) => ({
            ...cur,
            count: cur.count + 1,
            items: [...cur.items, `item-${i}`],
          }))
        )
      )

      fixture.manager.clearCache(fixture.testProjectId)
      const result = await fixture.manager.read(fixture.testProjectId)
      expect(result.count).toBe(N)
      expect(result.items.length).toBe(N)
      expect(new Set(result.items).size).toBe(N) // every concurrent write survived
    })

    it('should handle multiple sequential updates', async () => {
      await fixture.manager.write(fixture.testProjectId, { value: 'start', count: 0, items: [] })

      // Multiple updates
      for (const _ of Array.from({ length: 5 })) {
        await fixture.manager.update(fixture.testProjectId, (current) => ({
          ...current,
          count: current.count + 1,
        }))
      }

      const result = await fixture.manager.read(fixture.testProjectId)
      expect(result.count).toBe(5)
    })

    it('should maintain data integrity after failed read during update', async () => {
      // Start with no file (will use default)
      const result = await fixture.manager.update(fixture.testProjectId, (current) => ({
        ...current,
        value: 'from-default',
        count: 100,
      }))

      expect(result.value).toBe('from-default')
      expect(result.count).toBe(100)
    })
  })
})
