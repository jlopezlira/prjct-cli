/**
 * SQLite Migration & Integration Tests (PRJ-303)
 *
 * Tests for:
 * - Migration correctness (JSON → SQLite)
 * - Concurrent access (WAL mode)
 * - Query performance (SQLite vs JSON)
 * - Graceful degradation
 * - StorageManager + IndexStorage SQLite integration
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'
import { prjctDb } from '../../storage/database'
import { indexStorage } from '../../storage/index-storage'
import { StorageManager } from '../../storage/storage-manager'

// Test Setup

const fixture: { tmpRoot: string | null; testProjectId: string } = {
  tmpRoot: null,
  testProjectId: '',
}

const originalGetGlobalProjectPath = pathManager.getGlobalProjectPath.bind(pathManager)
const originalGetStoragePath = pathManager.getStoragePath.bind(pathManager)
const originalGetFilePath = pathManager.getFilePath.bind(pathManager)

// Concrete StorageManager for testing
interface TestData {
  value: string
  count: number
  items: string[]
}

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

function mockPaths() {
  pathManager.getGlobalProjectPath = (projectId: string) => {
    return path.join(fixture.tmpRoot!, projectId)
  }

  pathManager.getStoragePath = (projectId: string, filename: string) => {
    return path.join(fixture.tmpRoot!, projectId, 'storage', filename)
  }

  pathManager.getFilePath = (projectId: string, layer: string, filename: string) => {
    return path.join(fixture.tmpRoot!, projectId, layer, filename)
  }
}

function restorePaths() {
  pathManager.getGlobalProjectPath = originalGetGlobalProjectPath
  pathManager.getStoragePath = originalGetStoragePath
  pathManager.getFilePath = originalGetFilePath
}

// Migration Correctness Tests

describe('SQLite Migration', () => {
  beforeEach(async () => {
    fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-sqlite-test-'))
    fixture.testProjectId = 'test-project-migration'
    mockPaths()
  })

  afterEach(async () => {
    prjctDb.close()
    restorePaths()
    if (fixture.tmpRoot) {
      await fs.rm(fixture.tmpRoot, { recursive: true, force: true })
      fixture.tmpRoot = null
    }
  })

  // Concurrent Access Tests (WAL Mode)

  describe('concurrent access', () => {
    it('should handle multiple concurrent reads', async () => {
      const manager = new TestStorageManager()
      const data: TestData = { value: 'concurrent', count: 42, items: ['a', 'b'] }
      await manager.write(fixture.testProjectId, data)
      manager.clearCache()

      // Fire off multiple concurrent reads
      const reads = Array.from({ length: 10 }, () => manager.read(fixture.testProjectId))
      const results = await Promise.all(reads)

      for (const result of results) {
        expect(result).toEqual(data)
      }
    })

    it('should handle concurrent writes to different projects', async () => {
      const manager = new TestStorageManager()
      const projects = ['proj-a', 'proj-b', 'proj-c']

      // Write to different projects concurrently
      const writes = projects.map((id, i) =>
        manager.write(id, { value: `project-${i}`, count: i, items: [] })
      )
      await Promise.all(writes)

      // Verify each project has correct data
      for (const i of projects.keys()) {
        manager.clearCache(projects[i])
        const result = await manager.read(projects[i])
        expect(result.value).toBe(`project-${i}`)
        expect(result.count).toBe(i)
      }
    })

    it('should handle sequential updates consistently', async () => {
      const manager = new TestStorageManager()
      await manager.write(fixture.testProjectId, { value: 'start', count: 0, items: [] })

      // Run sequential updates
      for (const i of Array.from({ length: 10 }, (_, index) => index + 1)) {
        await manager.update(fixture.testProjectId, (current) => ({
          ...current,
          count: current.count + 1,
          items: [...current.items, `item-${i}`],
        }))
      }

      const result = await manager.read(fixture.testProjectId)
      expect(result.count).toBe(10)
      expect(result.items).toHaveLength(10)
    })
  })

  // Query Performance Tests

  describe('query performance', () => {
    it('should perform SQLite reads efficiently', async () => {
      const manager = new TestStorageManager()
      const data: TestData = {
        value: 'perf-test',
        count: 100,
        items: Array.from({ length: 50 }, (_, i) => `item-${i}`),
      }
      await manager.write(fixture.testProjectId, data)

      // Benchmark SQLite read (direct)
      const sqliteStart = performance.now()
      Array.from({ length: 100 }).forEach(() => {
        prjctDb.getDoc(fixture.testProjectId, 'test-data')
      })
      const sqliteTime = performance.now() - sqliteStart

      // Verify data is correct
      const sqliteResult = prjctDb.getDoc<TestData>(fixture.testProjectId, 'test-data')
      expect(sqliteResult).toEqual(data)

      // Log for informational purposes
      console.log(`  SQLite: ${sqliteTime.toFixed(2)}ms (100 reads)`)
    })

    it('should handle indexed queries efficiently', () => {
      // Seed the normalized subtasks table directly (10 completed, 10 pending).
      prjctDb.run(
        fixture.testProjectId,
        `INSERT INTO tasks (id, description, type, status, started_at)
         VALUES ('perf-task', 'Performance test', 'feature', 'active', '2026-01-01T00:00:00.000Z')`
      )
      for (const i of Array.from({ length: 20 }, (_, index) => index)) {
        prjctDb.run(
          fixture.testProjectId,
          `INSERT INTO subtasks (id, task_id, description, status, domain, sort_order)
           VALUES (?, 'perf-task', ?, ?, ?, ?)`,
          `st-${i}`,
          `Subtask ${i}`,
          i < 10 ? 'completed' : 'pending',
          i % 2 === 0 ? 'backend' : 'frontend',
          i
        )
      }

      // Indexed query: find completed subtasks
      const start = performance.now()
      const completed = prjctDb.query<{ id: string }>(
        fixture.testProjectId,
        'SELECT id FROM subtasks WHERE status = ?',
        'completed'
      )
      const queryTime = performance.now() - start

      expect(completed).toHaveLength(10)
      // Indexed query should be sub-millisecond
      expect(queryTime).toBeLessThan(10)
    })
  })

  // StorageManager SQLite Integration

  describe('StorageManager SQLite integration', () => {
    it('should write to SQLite only (no JSON file)', async () => {
      const manager = new TestStorageManager()
      const data: TestData = { value: 'sqlite-write', count: 7, items: ['x'] }

      await manager.write(fixture.testProjectId, data)

      // Verify SQLite has it
      const sqliteData = prjctDb.getDoc<TestData>(fixture.testProjectId, 'test-data')
      expect(sqliteData).toEqual(data)

      // Verify JSON file does NOT exist
      const jsonPath = pathManager.getStoragePath(fixture.testProjectId, 'test-data.json')
      await expect(fs.access(jsonPath)).rejects.toThrow()
    })

    it('should read from SQLite', async () => {
      const manager = new TestStorageManager()
      const data: TestData = { value: 'sqlite-only', count: 3, items: [] }

      await manager.write(fixture.testProjectId, data)
      manager.clearCache()

      const result = await manager.read(fixture.testProjectId)
      expect(result).toEqual(data)
    })

    it('should return default when SQLite has no data', async () => {
      const manager = new TestStorageManager()
      const result = await manager.read('nonexistent-project')

      expect(result).toEqual({ value: '', count: 0, items: [] })
    })
  })

  // IndexStorage SQLite Integration

  describe('IndexStorage SQLite integration', () => {
    it('should write index to SQLite only (no JSON file)', async () => {
      // Ensure project directory exists for DB creation
      await fs.mkdir(path.join(fixture.tmpRoot!, fixture.testProjectId), { recursive: true })

      const projectIndex = {
        version: '1.0.0',
        projectPath: '/test',
        lastFullScan: '2026-01-01T00:00:00.000Z',
        lastIncrementalUpdate: '',
        languages: {},
        configFiles: [],
        directories: [],
        relevantFiles: [],
        patterns: [],
        detectedStack: {
          ecosystem: 'JavaScript',
          frameworks: [],
          hasTests: false,
          hasDocker: false,
          hasCi: false,
          buildTool: null,
        },
        totalFiles: 10,
        totalSize: 1000,
        totalLines: 100,
        scanDuration: 5,
      }

      await indexStorage.writeIndex(fixture.testProjectId, projectIndex)

      // Verify SQLite index_meta
      const row = prjctDb.get<{ data: string }>(
        fixture.testProjectId,
        'SELECT data FROM index_meta WHERE key = ?',
        'project-index'
      )
      expect(row).not.toBeNull()
      const parsed = JSON.parse(row!.data)
      expect(parsed.totalFiles).toBe(10)

      // Verify JSON file does NOT exist
      const jsonPath = path.join(
        indexStorage.getIndexPath(fixture.testProjectId),
        'project-index.json'
      )
      await expect(fs.access(jsonPath)).rejects.toThrow()
    })

    it('should read index from SQLite', async () => {
      await fs.mkdir(path.join(fixture.tmpRoot!, fixture.testProjectId), { recursive: true })

      const projectIndex = {
        version: '1.0.0',
        projectPath: '/test',
        lastFullScan: '2026-01-01T00:00:00.000Z',
        lastIncrementalUpdate: '',
        languages: {},
        configFiles: [],
        directories: [],
        relevantFiles: [],
        patterns: [],
        detectedStack: {
          ecosystem: 'JavaScript',
          frameworks: [],
          hasTests: false,
          hasDocker: false,
          hasCi: false,
          buildTool: null,
        },
        totalFiles: 20,
        totalSize: 2000,
        totalLines: 200,
        scanDuration: 10,
      }

      await indexStorage.writeIndex(fixture.testProjectId, projectIndex)

      const result = await indexStorage.readIndex(fixture.testProjectId)
      expect(result).not.toBeNull()
      expect(result!.totalFiles).toBe(20)
    })

    it('should write and read checksums via SQLite', async () => {
      await fs.mkdir(path.join(fixture.tmpRoot!, fixture.testProjectId), { recursive: true })

      const checksums = {
        version: '1.0.0',
        lastUpdated: '2026-01-01T00:00:00.000Z',
        checksums: { 'a.ts': 'hash1', 'b.ts': 'hash2' },
      }

      await indexStorage.writeChecksums(fixture.testProjectId, checksums)

      const result = await indexStorage.readChecksums(fixture.testProjectId)
      expect(result.checksums['a.ts']).toBe('hash1')
      expect(result.checksums['b.ts']).toBe('hash2')
    })

    it('should write and read file scores via SQLite', async () => {
      await fs.mkdir(path.join(fixture.tmpRoot!, fixture.testProjectId), { recursive: true })

      const scores = [
        { path: 'src/main.ts', score: 0.95, size: 1000, mtime: '2026-01-01T00:00:00.000Z' },
        { path: 'src/utils.ts', score: 0.7, size: 500, mtime: '2026-01-01T00:00:00.000Z' },
      ]

      await indexStorage.writeScores(fixture.testProjectId, scores)

      const result = await indexStorage.readScores(fixture.testProjectId)
      expect(result).toHaveLength(2)
      expect(result[0].path).toBe('src/main.ts')
      expect(result[0].score).toBe(0.95)
    })

    it('should write and read domains via SQLite', async () => {
      await fs.mkdir(path.join(fixture.tmpRoot!, fixture.testProjectId), { recursive: true })

      const domains = {
        version: '1.0.0',
        projectId: fixture.testProjectId,
        domains: [
          {
            name: 'api',
            description: 'API layer',
            keywords: ['api'],
            filePatterns: ['**/api/**'],
            fileCount: 5,
          },
        ],
        discoveredAt: '2026-01-01T00:00:00.000Z',
      }

      await indexStorage.writeDomains(fixture.testProjectId, domains)

      const result = await indexStorage.readDomains(fixture.testProjectId)
      expect(result).not.toBeNull()
      expect(result!.domains[0].name).toBe('api')
    })

    it('should write and read categories via SQLite', async () => {
      await fs.mkdir(path.join(fixture.tmpRoot!, fixture.testProjectId), { recursive: true })

      const cache = {
        version: '1.0.0',
        lastUpdate: '2026-01-01T00:00:00.000Z',
        fileCategories: [
          {
            path: 'src/api.ts',
            categories: ['api', 'backend'],
            primaryDomain: 'api',
            confidence: 0.9,
            categorizedAt: '2026-01-01T00:00:00.000Z',
            method: 'heuristic' as const,
          },
        ],
        domainIndex: { api: ['src/api.ts'] },
      }

      await indexStorage.writeCategories(fixture.testProjectId, cache)

      const result = await indexStorage.readCategories(fixture.testProjectId)
      expect(result).not.toBeNull()
      expect(result!.fileCategories[0].path).toBe('src/api.ts')
    })

    it('should clear SQLite on clearIndex', async () => {
      await fs.mkdir(path.join(fixture.tmpRoot!, fixture.testProjectId), { recursive: true })

      await indexStorage.writeIndex(fixture.testProjectId, {
        version: '1.0.0',
        projectPath: '/test',
        lastFullScan: '2026-01-01T00:00:00.000Z',
        lastIncrementalUpdate: '',
        languages: {},
        configFiles: [],
        directories: [],
        relevantFiles: [],
        patterns: [],
        detectedStack: {
          ecosystem: 'JavaScript',
          frameworks: [],
          hasTests: false,
          hasDocker: false,
          hasCi: false,
          buildTool: null,
        },
        totalFiles: 1,
        totalSize: 1,
        totalLines: 1,
        scanDuration: 1,
      })

      await indexStorage.clearIndex(fixture.testProjectId)

      const sqliteRow = prjctDb.get<{ data: string }>(
        fixture.testProjectId,
        'SELECT data FROM index_meta WHERE key = ?',
        'project-index'
      )
      expect(sqliteRow).toBeNull()

      const result = await indexStorage.readIndex(fixture.testProjectId)
      expect(result).toBeNull()
    })

    it('should return null for outdated index version', async () => {
      // Ensure project directory exists for DB creation
      await fs.mkdir(path.join(fixture.tmpRoot!, fixture.testProjectId), { recursive: true })
      // Write directly to SQLite with wrong version
      const db = prjctDb.getDb(fixture.testProjectId)
      db.prepare('INSERT OR REPLACE INTO index_meta (key, data, updated_at) VALUES (?, ?, ?)').run(
        'project-index',
        JSON.stringify({ version: '0.0.1', totalFiles: 5 }),
        new Date().toISOString()
      )

      const result = await indexStorage.readIndex(fixture.testProjectId)
      expect(result).toBeNull()
    })
  })

  // Database Manager Tests

  describe('database manager', () => {
    it('should create tables on first access', async () => {
      await fs.mkdir(path.join(fixture.tmpRoot!, fixture.testProjectId), { recursive: true })
      const db = prjctDb.getDb(fixture.testProjectId)
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>

      const tableNames = tables.map((t) => t.name)
      expect(tableNames).toContain('kv_store')
      expect(tableNames).toContain('tasks')
      expect(tableNames).toContain('subtasks')
      expect(tableNames).toContain('events')
      expect(tableNames).toContain('index_meta')
      expect(tableNames).toContain('index_files')
      expect(tableNames).toContain('index_checksums')
      // `memory` (singular, legacy KV) was dropped with the migrate-json
      // retirement; the live authored-memory table is `memory_entries`.
      expect(tableNames).toContain('memory_entries')
    })

    it('should track migrations', async () => {
      await fs.mkdir(path.join(fixture.tmpRoot!, fixture.testProjectId), { recursive: true })
      prjctDb.getDb(fixture.testProjectId) // Ensure DB is initialized
      const migrations = prjctDb.getMigrations(fixture.testProjectId)
      expect(migrations.length).toBeGreaterThan(0)
      expect(migrations[0].name).toBe('initial-schema')
    })

    it('scrubs literal friction transcript evidence from existing memory rows', async () => {
      await fs.mkdir(path.join(fixture.tmpRoot!, fixture.testProjectId), { recursive: true })
      const db = prjctDb.getDb(fixture.testProjectId)
      const literal = [
        '[negation] Lesson: Recalibrate before continuing.',
        'What happened: The user pushed back after the assistant response.',
        'Why it mattered: The assistant likely violated sequencing expectations.',
        'Pattern: User immediately rejects an assistant action.',
        'Anti-pattern: Continuing without changing course.',
        'Next action: Pause and adjust the next tool use.',
        'Evidence: user said "no literal quotes" after assistant said "I will continue".',
      ].join('\n')

      db.run('DELETE FROM _migrations WHERE version = 35')
      prjctDb.appendEvent(fixture.testProjectId, 'memory.remember.improvement-signal', {
        content: literal,
        tags: { source: 'friction-detector' },
        provenance: 'extracted',
      })

      prjctDb.close(fixture.testProjectId)
      prjctDb.getDb(fixture.testProjectId)

      // v35 scrubs the friction evidence from the authoritative events log
      // (memory_entries is rebuilt from events; the `memories` mirror is retired).
      const event = prjctDb.get<{ data: string }>(
        fixture.testProjectId,
        `SELECT data FROM events
         WHERE type = 'memory.remember.improvement-signal'
         ORDER BY id DESC LIMIT 1`
      )
      const eventContent = JSON.parse(event!.data).content as string

      expect(eventContent).toContain('Why it mattered:')
      expect(eventContent).toContain('Next action:')
      expect(eventContent).not.toContain('Evidence:')
      expect(eventContent).not.toContain('no literal quotes')
    })

    it('should support document CRUD operations', async () => {
      await fs.mkdir(path.join(fixture.tmpRoot!, fixture.testProjectId), { recursive: true })
      // Create
      prjctDb.setDoc(fixture.testProjectId, 'test-key', { hello: 'world' })
      expect(prjctDb.hasDoc(fixture.testProjectId, 'test-key')).toBe(true)

      // Read
      const doc = prjctDb.getDoc<{ hello: string }>(fixture.testProjectId, 'test-key')
      expect(doc).not.toBeNull()
      expect(doc!.hello).toBe('world')

      // Update
      prjctDb.setDoc(fixture.testProjectId, 'test-key', { hello: 'updated' })
      const updated = prjctDb.getDoc<{ hello: string }>(fixture.testProjectId, 'test-key')
      expect(updated!.hello).toBe('updated')

      // Delete
      prjctDb.deleteDoc(fixture.testProjectId, 'test-key')
      expect(prjctDb.hasDoc(fixture.testProjectId, 'test-key')).toBe(false)
      expect(prjctDb.getDoc(fixture.testProjectId, 'test-key')).toBeNull()
    })

    it('should support event log operations', async () => {
      await fs.mkdir(path.join(fixture.tmpRoot!, fixture.testProjectId), { recursive: true })
      prjctDb.appendEvent(fixture.testProjectId, 'test.event', { key: 'value' }, 'task-1')
      prjctDb.appendEvent(fixture.testProjectId, 'test.event', { key: 'value2' }, 'task-1')
      prjctDb.appendEvent(fixture.testProjectId, 'other.event', { key: 'value3' })

      const allEvents = prjctDb.getEvents(fixture.testProjectId)
      expect(allEvents).toHaveLength(3)

      const testEvents = prjctDb.getEvents(fixture.testProjectId, 'test.event')
      expect(testEvents).toHaveLength(2)
    })

    it('should support transactions', async () => {
      await fs.mkdir(path.join(fixture.tmpRoot!, fixture.testProjectId), { recursive: true })
      const result = prjctDb.transaction(fixture.testProjectId, (db) => {
        db.prepare('INSERT INTO kv_store (key, data, updated_at) VALUES (?, ?, ?)').run(
          'tx-key-1',
          '"value1"',
          new Date().toISOString()
        )
        db.prepare('INSERT INTO kv_store (key, data, updated_at) VALUES (?, ?, ?)').run(
          'tx-key-2',
          '"value2"',
          new Date().toISOString()
        )
        return 'committed'
      })

      expect(result).toBe('committed')
      expect(prjctDb.hasDoc(fixture.testProjectId, 'tx-key-1')).toBe(true)
      expect(prjctDb.hasDoc(fixture.testProjectId, 'tx-key-2')).toBe(true)
    })
  })
})
