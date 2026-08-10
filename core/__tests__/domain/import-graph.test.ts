/**
 * Tests for Import Graph Builder
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildGraph, scoreFromSeeds } from '../../domain/import-graph'

describe('ImportGraph', () => {
  const fixture: {
    testDir: string
  } = {
    testDir: '',
  }

  beforeEach(async () => {
    fixture.testDir = path.join(os.tmpdir(), `prjct-import-graph-test-${Date.now()}`)
    await fs.mkdir(fixture.testDir, { recursive: true })
  })

  afterEach(async () => {
    try {
      await fs.rm(fixture.testDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  describe('buildGraph', () => {
    it('should build forward and reverse edges', async () => {
      await fs.writeFile(
        path.join(fixture.testDir, 'auth.ts'),
        `import { validate } from './validator'\nexport class Auth {}`
      )
      await fs.writeFile(
        path.join(fixture.testDir, 'validator.ts'),
        `export function validate() {}`
      )
      await fs.writeFile(
        path.join(fixture.testDir, 'middleware.ts'),
        `import { Auth } from './auth'\nexport function middleware() {}`
      )

      const graph = await buildGraph(fixture.testDir)

      // Forward: auth imports validator
      expect(graph.forward['auth.ts']).toContain('validator.ts')
      // Forward: middleware imports auth
      expect(graph.forward['middleware.ts']).toContain('auth.ts')

      // Reverse: validator is imported by auth
      expect(graph.reverse['validator.ts']).toContain('auth.ts')
      // Reverse: auth is imported by middleware
      expect(graph.reverse['auth.ts']).toContain('middleware.ts')
    })

    it('should count files and edges', async () => {
      await fs.writeFile(
        path.join(fixture.testDir, 'a.ts'),
        `import { b } from './b'\nimport { c } from './c'`
      )
      await fs.writeFile(path.join(fixture.testDir, 'b.ts'), `export const b = 1`)
      await fs.writeFile(path.join(fixture.testDir, 'c.ts'), `export const c = 2`)

      const graph = await buildGraph(fixture.testDir)
      expect(graph.fileCount).toBe(3)
      expect(graph.edgeCount).toBe(2)
    })

    it('should skip external imports', async () => {
      await fs.writeFile(
        path.join(fixture.testDir, 'app.ts'),
        `import express from 'express'\nimport { helper } from './helper'`
      )
      await fs.writeFile(path.join(fixture.testDir, 'helper.ts'), `export function helper() {}`)

      const graph = await buildGraph(fixture.testDir)
      expect(graph.forward['app.ts']).toEqual(['helper.ts'])
      // express should not appear
      expect(graph.forward['app.ts']).not.toContain('express')
    })

    it('should skip node_modules', async () => {
      await fs.mkdir(path.join(fixture.testDir, 'node_modules'), { recursive: true })
      await fs.writeFile(path.join(fixture.testDir, 'node_modules', 'pkg.ts'), `export default {}`)
      await fs.writeFile(path.join(fixture.testDir, 'main.ts'), `export function main() {}`)

      const graph = await buildGraph(fixture.testDir)
      expect(graph.fileCount).toBe(1)
    })

    it('should skip .worktrees directory', async () => {
      await fs.mkdir(path.join(fixture.testDir, '.worktrees', 'test-task'), { recursive: true })
      await fs.writeFile(
        path.join(fixture.testDir, '.worktrees', 'test-task', 'auth.ts'),
        `import { db } from './db'\nexport class Auth {}`
      )
      await fs.writeFile(path.join(fixture.testDir, 'auth.ts'), `export function login() {}`)

      const graph = await buildGraph(fixture.testDir)
      expect(graph.fileCount).toBe(1)
      expect(graph.forward['.worktrees/test-task/auth.ts']).toBeUndefined()
    })
  })

  describe('scoreFromSeeds', () => {
    it('should score direct imports at 0.5', async () => {
      await fs.writeFile(
        path.join(fixture.testDir, 'auth.ts'),
        `import { middleware } from './middleware'\nexport class Auth {}`
      )
      await fs.writeFile(
        path.join(fixture.testDir, 'middleware.ts'),
        `export function middleware() {}`
      )
      await fs.writeFile(
        path.join(fixture.testDir, 'unrelated.ts'),
        `export function unrelated() {}`
      )

      const graph = await buildGraph(fixture.testDir)
      const scores = scoreFromSeeds(['auth.ts'], graph)

      const middlewareScore = scores.find((s) => s.path === 'middleware.ts')
      expect(middlewareScore).toBeDefined()
      expect(middlewareScore!.score).toBe(0.5) // 1 / (1 + 1) = 0.5
      expect(middlewareScore!.depth).toBe(1)

      // unrelated.ts should not appear
      const unrelatedScore = scores.find((s) => s.path === 'unrelated.ts')
      expect(unrelatedScore).toBeUndefined()
    })

    it('should score 2nd-level imports at 0.33', async () => {
      await fs.writeFile(
        path.join(fixture.testDir, 'auth.ts'),
        `import { session } from './session'`
      )
      await fs.writeFile(
        path.join(fixture.testDir, 'session.ts'),
        `import { db } from './db'\nexport function session() {}`
      )
      await fs.writeFile(path.join(fixture.testDir, 'db.ts'), `export function db() {}`)

      const graph = await buildGraph(fixture.testDir)
      const scores = scoreFromSeeds(['auth.ts'], graph, 2)

      const sessionScore = scores.find((s) => s.path === 'session.ts')
      expect(sessionScore).toBeDefined()
      expect(sessionScore!.depth).toBe(1)

      const dbScore = scores.find((s) => s.path === 'db.ts')
      expect(dbScore).toBeDefined()
      expect(dbScore!.depth).toBe(2)
      expect(dbScore!.score).toBeCloseTo(1 / 3, 2)
    })

    it('should follow reverse edges (imported-by)', async () => {
      await fs.writeFile(path.join(fixture.testDir, 'auth.ts'), `export function auth() {}`)
      await fs.writeFile(
        path.join(fixture.testDir, 'middleware.ts'),
        `import { auth } from './auth'\nexport function middleware() {}`
      )

      const graph = await buildGraph(fixture.testDir)
      // Seed is auth.ts, middleware imports auth → should appear via reverse edge
      const scores = scoreFromSeeds(['auth.ts'], graph)

      const middlewareScore = scores.find((s) => s.path === 'middleware.ts')
      expect(middlewareScore).toBeDefined()
    })

    it('should not include seed files in results', async () => {
      await fs.writeFile(path.join(fixture.testDir, 'a.ts'), `import { b } from './b'`)
      await fs.writeFile(path.join(fixture.testDir, 'b.ts'), `export const b = 1`)

      const graph = await buildGraph(fixture.testDir)
      const scores = scoreFromSeeds(['a.ts'], graph)

      expect(scores.find((s) => s.path === 'a.ts')).toBeUndefined()
    })
  })
})
