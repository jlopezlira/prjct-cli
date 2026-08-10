/**
 * Tests for Combined File Ranker
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { indexProject } from '../../domain/bm25'
import { hasIndexes, rankFiles } from '../../domain/file-ranker'
import { indexCoChanges } from '../../domain/git-cochange'
import { indexImports } from '../../domain/import-graph'
import pathManager from '../../infrastructure/path-manager'
import prjctDb from '../../storage/database'

import { execAsync } from '../../utils/exec'

describe('FileRanker', () => {
  const fixture: {
    testDir: string
    testProjectId: string
  } = {
    testDir: '',
    testProjectId: '',
  }

  const originalGetGlobalProjectPath = pathManager.getGlobalProjectPath.bind(pathManager)

  beforeEach(async () => {
    fixture.testDir = path.join(os.tmpdir(), `prjct-ranker-test-${Date.now()}`)
    fixture.testProjectId = `test-ranker-${Date.now()}`
    await fs.mkdir(fixture.testDir, { recursive: true })

    // Mock path manager to use temp dir
    pathManager.getGlobalProjectPath = () => fixture.testDir

    // Initialize git repo
    await execAsync('git init', { cwd: fixture.testDir })
    await execAsync('git config user.email "test@test.com"', { cwd: fixture.testDir })
    await execAsync('git config user.name "Test"', { cwd: fixture.testDir })
  })

  afterEach(async () => {
    pathManager.getGlobalProjectPath = originalGetGlobalProjectPath
    prjctDb.close()
    try {
      await fs.rm(fixture.testDir, { recursive: true, force: true })
    } catch {
      // Ignore
    }
  })

  describe('hasIndexes', () => {
    it('should return false when no indexes exist', () => {
      const result = hasIndexes(fixture.testProjectId)
      expect(result.bm25).toBe(false)
      expect(result.imports).toBe(false)
      expect(result.cochange).toBe(false)
    })

    it('should return true after building indexes', async () => {
      // Create a test file
      await fs.writeFile(path.join(fixture.testDir, 'app.ts'), 'export function main() {}')
      await execAsync('git add -A && git commit -m "init"', { cwd: fixture.testDir })

      await indexProject(fixture.testDir, fixture.testProjectId)
      await indexImports(fixture.testDir, fixture.testProjectId)
      await indexCoChanges(fixture.testDir, fixture.testProjectId)

      const result = hasIndexes(fixture.testProjectId)
      expect(result.bm25).toBe(true)
      expect(result.imports).toBe(true)
      expect(result.cochange).toBe(true)
    })
  })

  describe('rankFiles', () => {
    it('should return empty array when no indexes exist', () => {
      const result = rankFiles(fixture.testProjectId, 'anything')
      expect(result).toEqual([])
    })

    it('should rank relevant files higher', async () => {
      // Create auth-related files
      await fs.writeFile(
        path.join(fixture.testDir, 'auth.ts'),
        `// Authentication service for JWT handling\nexport class AuthService {\n  validateJwt(token: string) { return true }\n}`
      )
      await fs.writeFile(
        path.join(fixture.testDir, 'middleware.ts'),
        `import { AuthService } from './auth'\n// Auth middleware\nexport function authMiddleware() {}`
      )
      await fs.writeFile(
        path.join(fixture.testDir, 'session.ts'),
        `import { AuthService } from './auth'\n// Session management\nexport function refreshSession() {}`
      )
      // Create unrelated file
      await fs.writeFile(
        path.join(fixture.testDir, 'button.tsx'),
        `// UI button component\nexport function Button() { return null }`
      )

      // Create git history with co-changes
      await execAsync('git add -A && git commit -m "init"', { cwd: fixture.testDir })
      await fs.writeFile(
        path.join(fixture.testDir, 'auth.ts'),
        `export class AuthService { v2() {} }`
      )
      await fs.writeFile(
        path.join(fixture.testDir, 'middleware.ts'),
        `export function authMiddleware() { v2 }`
      )
      await execAsync('git add -A && git commit -m "update auth"', { cwd: fixture.testDir })

      // Build all indexes
      await indexProject(fixture.testDir, fixture.testProjectId)
      await indexImports(fixture.testDir, fixture.testProjectId)
      await indexCoChanges(fixture.testDir, fixture.testProjectId)

      const results = rankFiles(fixture.testProjectId, 'Fix auth middleware for JWT validation')

      expect(results.length).toBeGreaterThan(0)

      // Auth and middleware should be in results
      const authResult = results.find((r) => r.path === 'auth.ts')
      const middlewareResult = results.find((r) => r.path === 'middleware.ts')

      expect(authResult).toBeDefined()
      expect(middlewareResult).toBeDefined()

      // Auth should rank higher than button
      const buttonResult = results.find((r) => r.path === 'button.tsx')
      if (authResult && buttonResult) {
        expect(authResult.finalScore).toBeGreaterThan(buttonResult.finalScore)
      }
    })

    it('should include signal breakdown', async () => {
      await fs.writeFile(
        path.join(fixture.testDir, 'auth.ts'),
        `// Authentication\nexport class AuthService {}`
      )
      await execAsync('git add -A && git commit -m "init"', { cwd: fixture.testDir })

      await indexProject(fixture.testDir, fixture.testProjectId)
      await indexImports(fixture.testDir, fixture.testProjectId)
      await indexCoChanges(fixture.testDir, fixture.testProjectId)

      const results = rankFiles(fixture.testProjectId, 'authentication')

      if (results.length > 0) {
        const first = results[0]
        expect(first.signals).toBeDefined()
        expect(typeof first.signals.bm25).toBe('number')
        expect(typeof first.signals.imports).toBe('number')
        expect(typeof first.signals.cochange).toBe('number')
      }
    })

    it('should respect topN config', async () => {
      // Create many files
      for (const i of Array.from({ length: 20 }, (_, index) => index)) {
        await fs.writeFile(
          path.join(fixture.testDir, `service-${i}.ts`),
          `// Service module ${i}\nexport function service${i}() {}`
        )
      }
      await execAsync('git add -A && git commit -m "init"', { cwd: fixture.testDir })

      await indexProject(fixture.testDir, fixture.testProjectId)

      const results = rankFiles(fixture.testProjectId, 'service module', { topN: 5 })
      expect(results.length).toBeLessThanOrEqual(5)
    })
  })
})
