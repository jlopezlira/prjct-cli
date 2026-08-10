/**
 * Staleness Checker Tests (PRJ-120)
 *
 * Tests for the StalenessChecker service:
 * - Fresh context detection
 * - Stale context detection (commits, days, significant files)
 * - No sync history handling
 * - Output formatting
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'
import { createStalenessChecker } from '../../services/staleness-checker'
import { prjctDb } from '../../storage/database'
import type { StalenessStatus } from '../../types/services.js'

// Test Setup

const fixture: {
  tmpRoot: string | null
  testProjectId: string
} = {
  tmpRoot: null,
  testProjectId: '',
}

const originalGetGlobalProjectPath = pathManager.getGlobalProjectPath.bind(pathManager)

describe('StalenessChecker', () => {
  beforeEach(async () => {
    fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-staleness-test-'))
    fixture.testProjectId = 'staleness-test-project'

    // Mock pathManager to use temp directory
    pathManager.getGlobalProjectPath = (projectId: string) => {
      return path.join(fixture.tmpRoot!, projectId)
    }
  })

  afterEach(async () => {
    prjctDb.close(fixture.testProjectId)
    pathManager.getGlobalProjectPath = originalGetGlobalProjectPath

    if (fixture.tmpRoot) {
      await fs.rm(fixture.tmpRoot, { recursive: true, force: true })
      fixture.tmpRoot = null
    }
  })

  // No Sync History Tests

  describe('no sync history', () => {
    it('should report stale when no project.json exists', async () => {
      const checker = createStalenessChecker(process.cwd())
      const status = await checker.check(fixture.testProjectId)

      expect(status.isStale).toBe(true)
      expect(status.reason).toContain('No sync history found')
    })

    it('should report stale when no lastSyncCommit in project doc', async () => {
      // Write project doc to SQLite without lastSyncCommit
      prjctDb.setDoc(fixture.testProjectId, 'project', {
        name: 'test',
        lastSync: new Date().toISOString(),
      })

      const checker = createStalenessChecker(process.cwd())
      const status = await checker.check(fixture.testProjectId)

      expect(status.isStale).toBe(true)
      expect(status.reason).toContain('No sync commit recorded')
    })
  })

  // Status Formatting Tests

  describe('formatStatus', () => {
    it('should format fresh status correctly', () => {
      const checker = createStalenessChecker(process.cwd())
      const status: StalenessStatus = {
        isStale: false,
        reason: 'Context is up to date',
        lastSyncCommit: 'abc123',
        currentCommit: 'abc123',
        commitsSinceSync: 0,
        daysSinceSync: 0,
        changedFiles: [],
        significantChanges: [],
      }

      const formatted = checker.formatStatus(status)

      expect(formatted).toContain('✓ Fresh')
      expect(formatted).toContain('Last sync:')
      expect(formatted).toContain('abc123')
      expect(formatted).not.toContain('Run `prjct sync`')
    })

    it('should format stale status with sync prompt', () => {
      const checker = createStalenessChecker(process.cwd())
      const status: StalenessStatus = {
        isStale: true,
        reason: '15 commits since last sync (threshold: 10)',
        lastSyncCommit: 'abc123',
        currentCommit: 'def456',
        commitsSinceSync: 15,
        daysSinceSync: 2,
        changedFiles: ['src/index.ts', 'package.json'],
        significantChanges: ['package.json'],
      }

      const formatted = checker.formatStatus(status)

      expect(formatted).toContain('⚠️  STALE')
      expect(formatted).toContain('15')
      expect(formatted).toContain('Significant changes')
      expect(formatted).toContain('package.json')
      expect(formatted).toContain('Run `prjct sync`')
    })
  })

  // Warning Message Tests

  describe('getWarning', () => {
    it('should return null for fresh status', () => {
      const checker = createStalenessChecker(process.cwd())
      const status: StalenessStatus = {
        isStale: false,
        reason: 'Context is up to date',
        lastSyncCommit: 'abc123',
        currentCommit: 'abc123',
        commitsSinceSync: 0,
        daysSinceSync: 0,
        changedFiles: [],
        significantChanges: [],
      }

      const warning = checker.getWarning(status)
      expect(warning).toBeNull()
    })

    it('should return commit-based warning', () => {
      const checker = createStalenessChecker(process.cwd())
      const status: StalenessStatus = {
        isStale: true,
        reason: '15 commits since last sync',
        lastSyncCommit: 'abc123',
        currentCommit: 'def456',
        commitsSinceSync: 15,
        daysSinceSync: 0,
        changedFiles: [],
        significantChanges: [],
      }

      const warning = checker.getWarning(status)
      expect(warning).toContain('15 commits behind')
      expect(warning).toContain('prjct sync')
    })

    it('should return days-based warning', () => {
      const checker = createStalenessChecker(process.cwd())
      const status: StalenessStatus = {
        isStale: true,
        reason: '5 days since last sync',
        lastSyncCommit: 'abc123',
        currentCommit: 'abc123',
        commitsSinceSync: 0,
        daysSinceSync: 5,
        changedFiles: [],
        significantChanges: [],
      }

      const warning = checker.getWarning(status)
      expect(warning).toContain('5 days old')
      expect(warning).toContain('prjct sync')
    })
  })

  // Configuration Tests

  describe('configuration', () => {
    it('should use default thresholds', () => {
      const checker = createStalenessChecker(process.cwd())
      // Default commitThreshold is 10, dayThreshold is 3
      expect(checker).toBeDefined()
    })

    it('should accept custom thresholds', () => {
      const checker = createStalenessChecker(process.cwd(), {
        commitThreshold: 5,
        dayThreshold: 1,
        significantFiles: ['custom.config.js'],
      })
      expect(checker).toBeDefined()
    })
  })
})

/**
 * PATH-hijack: an empty dir as PATH means `git` resolves nowhere, so spawn
 * fails with a real ENOENT — exercises the infra-failure path without mocks.
 */
async function withBrokenGit<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-no-git-'))
  const oldPath = process.env.PATH
  process.env.PATH = dir
  try {
    return await fn()
  } finally {
    if (oldPath === undefined) delete process.env.PATH
    else process.env.PATH = oldPath
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

describe('typed git failures (WS1)', () => {
  it('reports "history changed" ONLY on a typed exit (sync commit really gone)', async () => {
    prjctDb.setDoc(fixture.testProjectId, 'project', {
      lastSyncCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      lastSync: new Date().toISOString(),
    })

    const checker = createStalenessChecker(process.cwd())
    const status = await checker.check(fixture.testProjectId)

    expect(status.isStale).toBe(true)
    expect(status.reason).toContain('history changed')
  })

  it('git infra failure (spawn) → staleness unknown, NEVER "history changed"', async () => {
    if (process.platform === 'win32') return
    prjctDb.setDoc(fixture.testProjectId, 'project', {
      lastSyncCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      lastSync: new Date().toISOString(),
    })

    await withBrokenGit(async () => {
      const status = await createStalenessChecker(process.cwd()).check(fixture.testProjectId)
      expect(status.isStale).toBe(false)
      expect(status.reason).toContain('unknown')
      expect(status.reason).not.toContain('history changed')
    })
  })
})
