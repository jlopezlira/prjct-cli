/**
 * ProjectIndex Tests
 *
 * Tests for the persistent project scanner with scoring
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'
import { FileScorer, RELEVANCE_THRESHOLD } from '../../services/file-scorer'
import { createProjectIndexer } from '../../services/project-index'
import { getDefaultIndex, indexStorage } from '../../storage/index-storage'

describe('FileScorer', () => {
  describe('scoreFile', () => {
    it('should give higher scores to recently modified files', () => {
      const scorer = new FileScorer()

      const recentFile = {
        path: 'src/recent.ts',
        size: 1000,
        mtime: new Date(), // today
      }

      const oldFile = {
        path: 'src/old.ts',
        size: 1000,
        mtime: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000), // 1 year ago
      }

      const context = {
        allFiles: new Map([
          ['src/recent.ts', recentFile],
          ['src/old.ts', oldFile],
        ]),
        configFiles: new Set<string>(),
        maxFileSize: 1000,
        maxRecentCommits: 0,
        now: new Date(),
      }

      const recentScore = scorer.scoreFile(recentFile, context)
      const oldScore = scorer.scoreFile(oldFile, context)

      expect(recentScore.factors.recency).toBeGreaterThan(oldScore.factors.recency)
    })

    it('should give higher scores to config files', () => {
      const scorer = new FileScorer()

      const configFile = {
        path: 'package.json',
        size: 500,
        mtime: new Date(),
      }

      const sourceFile = {
        path: 'src/utils.ts',
        size: 500,
        mtime: new Date(),
      }

      const context = {
        allFiles: new Map([
          ['package.json', configFile],
          ['src/utils.ts', sourceFile],
        ]),
        configFiles: new Set(['package.json']),
        maxFileSize: 500,
        maxRecentCommits: 0,
        now: new Date(),
      }

      const configScore = scorer.scoreFile(configFile, context)
      const sourceScore = scorer.scoreFile(sourceFile, context)

      expect(configScore.factors.configRelevance).toBe(20)
      expect(sourceScore.factors.configRelevance).toBe(0)
    })

    it('should give higher scores to index/main files', () => {
      const scorer = new FileScorer()

      const indexFile = {
        path: 'src/index.ts',
        size: 500,
        mtime: new Date(),
      }

      const helperFile = {
        path: 'src/random-helper.ts',
        size: 500,
        mtime: new Date(),
      }

      const context = {
        allFiles: new Map([
          ['src/index.ts', indexFile],
          ['src/random-helper.ts', helperFile],
        ]),
        configFiles: new Set<string>(),
        maxFileSize: 500,
        maxRecentCommits: 0,
        now: new Date(),
      }

      const indexScore = scorer.scoreFile(indexFile, context)
      const helperScore = scorer.scoreFile(helperFile, context)

      expect(indexScore.factors.nameRelevance).toBe(15)
      expect(helperScore.factors.nameRelevance).toBe(0)
    })

    it('should penalize very large files', () => {
      const scorer = new FileScorer()

      const normalFile = {
        path: 'src/normal.ts',
        size: 5000, // 5KB - optimal
        mtime: new Date(),
      }

      const hugeFile = {
        path: 'src/huge.ts',
        size: 500000, // 500KB - too large
        mtime: new Date(),
      }

      const context = {
        allFiles: new Map([
          ['src/normal.ts', normalFile],
          ['src/huge.ts', hugeFile],
        ]),
        configFiles: new Set<string>(),
        maxFileSize: 500000,
        maxRecentCommits: 0,
        now: new Date(),
      }

      const normalScore = scorer.scoreFile(normalFile, context)
      const hugeScore = scorer.scoreFile(hugeFile, context)

      expect(normalScore.factors.sizeOptimal).toBeGreaterThan(hugeScore.factors.sizeOptimal)
    })
  })

  describe('getRelevantFiles', () => {
    it('should filter files below threshold', () => {
      const scorer = new FileScorer()

      // Config file should be relevant
      const configFile = {
        path: 'package.json',
        size: 500,
        mtime: new Date(),
      }

      // Random old file should not be relevant
      const randomFile = {
        path: 'src/old-unused.ts',
        size: 50, // very small
        mtime: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000), // old
      }

      const context = {
        allFiles: new Map([
          ['package.json', configFile],
          ['src/old-unused.ts', randomFile],
        ]),
        configFiles: new Set(['package.json']),
        maxFileSize: 500,
        maxRecentCommits: 0,
        now: new Date(),
      }

      const relevant = scorer.getRelevantFiles(context, RELEVANCE_THRESHOLD)

      expect(relevant.length).toBeGreaterThanOrEqual(1)
      expect(relevant[0].path).toBe('package.json')
    })
  })
})

describe('IndexStorage', () => {
  const fixture: {
    testProjectId: string
  } = {
    testProjectId: '',
  }

  beforeEach(async () => {
    // Generate unique project ID for each test to ensure isolation
    fixture.testProjectId = `test-project-${Date.now()}-${Math.random().toString(36).slice(2)}`
    // Set up test directory
    const testDir = path.join(os.tmpdir(), `prjct-test-${Date.now()}`)
    pathManager.setGlobalBaseDir(testDir)
  })

  afterEach(async () => {
    // Cleanup is handled by temp directory
  })

  describe('readIndex/writeIndex', () => {
    it('should return null for non-existent index', async () => {
      const index = await indexStorage.readIndex(fixture.testProjectId)
      expect(index).toBeNull()
    })

    it('should persist and retrieve index', async () => {
      const testIndex = getDefaultIndex('/test/project')
      testIndex.lastFullScan = new Date().toISOString()
      testIndex.totalFiles = 100

      await indexStorage.writeIndex(fixture.testProjectId, testIndex)
      const retrieved = await indexStorage.readIndex(fixture.testProjectId)

      expect(retrieved).not.toBeNull()
      expect(retrieved!.totalFiles).toBe(100)
      expect(retrieved!.lastFullScan).toBe(testIndex.lastFullScan)
    })
  })

  describe('hasValidIndex', () => {
    it('should return false for non-existent index', async () => {
      const valid = await indexStorage.hasValidIndex(fixture.testProjectId)
      expect(valid).toBe(false)
    })

    it('should return true for index with lastFullScan', async () => {
      const testIndex = getDefaultIndex('/test/project')
      testIndex.lastFullScan = new Date().toISOString()

      await indexStorage.writeIndex(fixture.testProjectId, testIndex)
      const valid = await indexStorage.hasValidIndex(fixture.testProjectId)

      expect(valid).toBe(true)
    })
  })
})

describe('ProjectIndexer', () => {
  const testProjectId = `test-indexer-${Date.now()}`
  const fixture: {
    testProjectPath: string
  } = {
    testProjectPath: '',
  }

  beforeEach(async () => {
    // Create a temp project directory
    fixture.testProjectPath = path.join(os.tmpdir(), `prjct-indexer-test-${Date.now()}`)
    await fs.mkdir(fixture.testProjectPath, { recursive: true })

    // Create some test files
    await fs.mkdir(path.join(fixture.testProjectPath, 'src'), { recursive: true })
    await fs.writeFile(
      path.join(fixture.testProjectPath, 'src', 'index.ts'),
      'export const main = () => {}'
    )
    await fs.writeFile(
      path.join(fixture.testProjectPath, 'src', 'utils.ts'),
      'export const helper = () => {}'
    )
    await fs.writeFile(
      path.join(fixture.testProjectPath, 'package.json'),
      JSON.stringify(
        {
          name: 'test-project',
          version: '1.0.0',
          dependencies: { express: '^4.0.0' },
          devDependencies: { typescript: '^5.0.0' },
        },
        null,
        2
      )
    )

    // Set up test storage directory
    const testStorageDir = path.join(os.tmpdir(), `prjct-storage-${Date.now()}`)
    pathManager.setGlobalBaseDir(testStorageDir)
  })

  afterEach(async () => {
    // Cleanup
    try {
      await fs.rm(fixture.testProjectPath, { recursive: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  describe('fullScan', () => {
    it('should scan project and create index', async () => {
      const indexer = createProjectIndexer(fixture.testProjectPath, testProjectId)
      const result = await indexer.fullScan()

      expect(result.fromCache).toBe(false)
      expect(result.index.totalFiles).toBeGreaterThanOrEqual(2)
      expect(result.index.lastFullScan).not.toBe('')
    })

    it('should detect TypeScript from config files', async () => {
      // Add tsconfig.json
      await fs.writeFile(
        path.join(fixture.testProjectPath, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { target: 'ES2020' },
        })
      )

      const indexer = createProjectIndexer(fixture.testProjectPath, testProjectId)
      const result = await indexer.fullScan()

      expect(result.index.configFiles.some((cf) => cf.type === 'tsconfig.json')).toBe(true)
    })

    it('should detect Express backend', async () => {
      const indexer = createProjectIndexer(fixture.testProjectPath, testProjectId)
      const result = await indexer.fullScan()

      expect(result.index.detectedStack.frameworks).toContain('Express')
    })
  })

  describe('loadOrScan', () => {
    it('should use cached index if valid', async () => {
      const indexer = createProjectIndexer(fixture.testProjectPath, testProjectId)

      // First scan
      const firstResult = await indexer.fullScan()
      expect(firstResult.fromCache).toBe(false)

      // Second load should use cache
      const secondResult = await indexer.loadOrScan()
      expect(secondResult.fromCache).toBe(true)
    })

    it('should rescan if forceFullScan is true', async () => {
      const indexer = createProjectIndexer(fixture.testProjectPath, testProjectId)

      // First scan
      await indexer.fullScan()

      // Force rescan
      const result = await indexer.loadOrScan({ forceFullScan: true })
      expect(result.fromCache).toBe(false)
    })
  })

  describe('getRelevantContext', () => {
    it('should return files within token limit', async () => {
      const indexer = createProjectIndexer(fixture.testProjectPath, testProjectId)
      await indexer.fullScan()

      const context = await indexer.getRelevantContext(10000)

      expect(context.estimatedTokens).toBeLessThanOrEqual(10000)
      expect(context.compressionRate).toBeGreaterThanOrEqual(-0.1)
    })
  })
})
