/**
 * Tests for Git Co-Change Analyzer
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildMatrix, scoreFromSeeds } from '../../domain/git-cochange'
import { execAsync } from '../../utils/exec'

describe('GitCoChange', () => {
  const fixture: {
    testDir: string
  } = {
    testDir: '',
  }

  beforeEach(async () => {
    fixture.testDir = path.join(os.tmpdir(), `prjct-cochange-test-${Date.now()}`)
    await fs.mkdir(fixture.testDir, { recursive: true })

    // Initialize a git repo
    await execAsync('git init', { cwd: fixture.testDir })
    await execAsync('git config user.email "test@test.com"', { cwd: fixture.testDir })
    await execAsync('git config user.name "Test"', { cwd: fixture.testDir })
  })

  afterEach(async () => {
    try {
      await fs.rm(fixture.testDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  describe('buildMatrix', () => {
    it('should detect co-changed files', async () => {
      // Create files that change together
      for (const i of Array.from({ length: 5 }, (_, index) => index)) {
        await fs.writeFile(path.join(fixture.testDir, 'auth.ts'), `export const v${i} = ${i}`)
        await fs.writeFile(path.join(fixture.testDir, 'middleware.ts'), `export const v${i} = ${i}`)
        await execAsync('git add -A', { cwd: fixture.testDir })
        await execAsync(`git commit -m "commit ${i}"`, { cwd: fixture.testDir })
      }

      // Create a file that changes independently
      await fs.writeFile(path.join(fixture.testDir, 'unrelated.ts'), 'export const x = 1')
      await execAsync('git add -A', { cwd: fixture.testDir })
      await execAsync('git commit -m "unrelated"', { cwd: fixture.testDir })

      const index = await buildMatrix(fixture.testDir, 100)

      expect(index.commitsAnalyzed).toBeGreaterThan(0)
      expect(index.matrix['auth.ts']).toBeDefined()
      expect(index.matrix['auth.ts']['middleware.ts']).toBeGreaterThan(0)

      // Auth and middleware should have high co-change
      const similarity = index.matrix['auth.ts']['middleware.ts']
      expect(similarity).toBeGreaterThan(0.5)
    })

    it('should be symmetric', async () => {
      for (const i of Array.from({ length: 3 }, (_, index) => index)) {
        await fs.writeFile(path.join(fixture.testDir, 'a.ts'), `const v${i} = ${i}`)
        await fs.writeFile(path.join(fixture.testDir, 'b.ts'), `const v${i} = ${i}`)
        await execAsync('git add -A', { cwd: fixture.testDir })
        await execAsync(`git commit -m "commit ${i}"`, { cwd: fixture.testDir })
      }

      const index = await buildMatrix(fixture.testDir, 100)

      if (index.matrix['a.ts'] && index.matrix['b.ts']) {
        expect(index.matrix['a.ts']['b.ts']).toBe(index.matrix['b.ts']['a.ts'])
      }
    })

    it('should handle no git history', async () => {
      const emptyDir = path.join(os.tmpdir(), `prjct-cochange-empty-${Date.now()}`)
      await fs.mkdir(emptyDir, { recursive: true })

      const index = await buildMatrix(emptyDir, 100)
      expect(index.commitsAnalyzed).toBe(0)
      expect(Object.keys(index.matrix)).toHaveLength(0)

      await fs.rm(emptyDir, { recursive: true, force: true })
    })
  })

  describe('scoreFromSeeds', () => {
    it('should score co-changed files', async () => {
      // Create co-change history
      for (const i of Array.from({ length: 5 }, (_, index) => index)) {
        await fs.writeFile(path.join(fixture.testDir, 'auth.ts'), `v${i}`)
        await fs.writeFile(path.join(fixture.testDir, 'session.ts'), `v${i}`)
        await execAsync('git add -A', { cwd: fixture.testDir })
        await execAsync(`git commit -m "commit ${i}"`, { cwd: fixture.testDir })
      }

      const index = await buildMatrix(fixture.testDir, 100)
      const scores = scoreFromSeeds(['auth.ts'], index)

      const sessionScore = scores.find((s) => s.path === 'session.ts')
      expect(sessionScore).toBeDefined()
      expect(sessionScore!.score).toBeGreaterThan(0)
    })

    it('should not include seed files in results', async () => {
      for (const i of Array.from({ length: 3 }, (_, index) => index)) {
        await fs.writeFile(path.join(fixture.testDir, 'a.ts'), `v${i}`)
        await fs.writeFile(path.join(fixture.testDir, 'b.ts'), `v${i}`)
        await execAsync('git add -A', { cwd: fixture.testDir })
        await execAsync(`git commit -m "commit ${i}"`, { cwd: fixture.testDir })
      }

      const index = await buildMatrix(fixture.testDir, 100)
      const scores = scoreFromSeeds(['a.ts'], index)

      expect(scores.find((s) => s.path === 'a.ts')).toBeUndefined()
    })
  })
})
