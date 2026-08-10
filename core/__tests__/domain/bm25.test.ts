/**
 * Tests for BM25 Text Search Index
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildIndex, score, tokenizeFile, tokenizeQuery } from '../../domain/bm25'

// Tokenization Tests

describe('BM25', () => {
  describe('tokenizeFile', () => {
    it('should extract path segments', () => {
      const tokens = tokenizeFile('', 'core/domain/bm25.ts')
      expect(tokens).toContain('core')
      expect(tokens).toContain('domain')
      expect(tokens).toContain('bm25')
    })

    it('should extract function names and split camelCase', () => {
      const content = 'export function getUserById(id: string) { return id }'
      const tokens = tokenizeFile(content, 'user-service.ts')
      expect(tokens).toContain('get')
      expect(tokens).toContain('user')
      // 'by' and 'id' are filtered (stop word / too short)
    })

    it('should extract class names', () => {
      const content = 'export class AuthMiddleware { handle() {} }'
      const tokens = tokenizeFile(content, 'middleware.ts')
      expect(tokens).toContain('auth')
      expect(tokens).toContain('middleware')
    })

    it('should extract interface names', () => {
      const content = 'export interface JwtPayload { sub: string }'
      const tokens = tokenizeFile(content, 'types.ts')
      expect(tokens).toContain('jwt')
      expect(tokens).toContain('payload')
    })

    it('should extract import sources', () => {
      const content = `import { Router } from './router'\nimport express from 'express'`
      const tokens = tokenizeFile(content, 'app.ts')
      expect(tokens).toContain('router')
      expect(tokens).toContain('express')
    })

    it('should extract words from comments', () => {
      const content = '// Handle authentication for JWT tokens'
      const tokens = tokenizeFile(content, 'auth.ts')
      expect(tokens).toContain('handle')
      expect(tokens).toContain('authentication')
      expect(tokens).toContain('jwt')
      expect(tokens).toContain('tokens')
    })

    it('should extract words from JSDoc comments', () => {
      const content = '/** Validates user session and refreshes token */'
      const tokens = tokenizeFile(content, 'session.ts')
      expect(tokens).toContain('validates')
      expect(tokens).toContain('session')
      expect(tokens).toContain('refreshes')
      expect(tokens).toContain('token')
    })

    it('should filter out stop words', () => {
      const content = 'export function getTheData() {}'
      const tokens = tokenizeFile(content, 'data.ts')
      expect(tokens).not.toContain('the')
      expect(tokens).not.toContain('export')
      expect(tokens).not.toContain('function')
    })

    it('should handle empty content', () => {
      const tokens = tokenizeFile('', 'empty.ts')
      // Should still have path segments
      expect(tokens).toContain('empty')
    })
  })

  describe('tokenizeQuery', () => {
    it('should tokenize a task description', () => {
      const tokens = tokenizeQuery('Fix the auth middleware for JWT validation')
      expect(tokens).toContain('fix')
      expect(tokens).toContain('auth')
      expect(tokens).toContain('middleware')
      expect(tokens).toContain('jwt')
      expect(tokens).toContain('validation')
    })

    it('should split camelCase in queries', () => {
      const tokens = tokenizeQuery('update getUserById function')
      expect(tokens).toContain('update')
      expect(tokens).toContain('get')
      expect(tokens).toContain('user')
    })

    it('should remove stop words from queries', () => {
      const tokens = tokenizeQuery('Fix the bug in the login')
      expect(tokens).not.toContain('the')
      expect(tokens).not.toContain('in')
      expect(tokens).toContain('fix')
      expect(tokens).toContain('bug')
      expect(tokens).toContain('login')
    })
  })

  // Index Building & Scoring Tests

  describe('buildIndex + score', () => {
    const fixture: {
      testDir: string
    } = {
      testDir: '',
    }

    beforeEach(async () => {
      fixture.testDir = path.join(os.tmpdir(), `prjct-bm25-test-${Date.now()}`)
      await fs.mkdir(fixture.testDir, { recursive: true })
    })

    afterEach(async () => {
      try {
        await fs.rm(fixture.testDir, { recursive: true, force: true })
      } catch {
        // Ignore cleanup errors
      }
    })

    it('should build an index from project files', async () => {
      // Create test files
      await fs.writeFile(
        path.join(fixture.testDir, 'auth.ts'),
        `export class AuthService {\n  validateJwt(token: string) {}\n  refreshSession() {}\n}`
      )
      await fs.writeFile(
        path.join(fixture.testDir, 'middleware.ts'),
        `import { AuthService } from './auth'\nexport function authMiddleware(req: any) {}`
      )
      await fs.writeFile(
        path.join(fixture.testDir, 'button.tsx'),
        `export function Button({ label }: { label: string }) {\n  return <button>{label}</button>\n}`
      )

      const index = await buildIndex(fixture.testDir)

      expect(index.totalDocs).toBe(3)
      expect(index.avgDocLength).toBeGreaterThan(0)
      expect(Object.keys(index.documents)).toContain('auth.ts')
      expect(Object.keys(index.documents)).toContain('middleware.ts')
      expect(Object.keys(index.documents)).toContain('button.tsx')
    })

    it('builds without crashing on prototype-colliding tokens (constructor/__proto__/toString)', async () => {
      // Regression: the inverted index was a plain `{}`, so a token equal to an
      // Object.prototype member made `!index[token]` truthy, skipped the `= []`
      // init, and threw on `.push` — aborting the WHOLE build (silently, via
      // sync's non-critical catch) and leaving file cues dark.
      await fs.writeFile(
        path.join(fixture.testDir, 'proto.ts'),
        `// constructor prototype hasOwnProperty valueOf toString __proto__ tokens here
         export class Thing {
           constructor() {}
           hasOwnProperty() {}
           toString() {}
           valueOf() {}
         }`
      )
      const index = await buildIndex(fixture.testDir)
      expect(index.totalDocs).toBe(1)
      // The colliding tokens are real, queryable index entries — not lost.
      expect(score('constructor prototype', index).length).toBeGreaterThan(0)
    })

    it('should rank auth files higher for auth query', async () => {
      await fs.writeFile(
        path.join(fixture.testDir, 'auth.ts'),
        `export class AuthService {\n  // Authenticate user with JWT\n  validateJwt(token: string) {}\n  refreshSession() {}\n}`
      )
      await fs.writeFile(
        path.join(fixture.testDir, 'middleware.ts'),
        `import { AuthService } from './auth'\n// Auth middleware for JWT validation\nexport function authMiddleware(req: any) {}`
      )
      await fs.writeFile(
        path.join(fixture.testDir, 'button.tsx'),
        `// Render a UI button component\nexport function Button({ label }: { label: string }) {\n  return <button>{label}</button>\n}`
      )

      const index = await buildIndex(fixture.testDir)
      const results = score('Fix the auth middleware for JWT validation', index)

      // Auth and middleware should rank higher than button
      expect(results.length).toBeGreaterThan(0)
      const authIndex = results.findIndex((r) => r.path === 'auth.ts')
      const middlewareIndex = results.findIndex((r) => r.path === 'middleware.ts')
      const buttonIndex = results.findIndex((r) => r.path === 'button.tsx')

      expect(authIndex).toBeLessThan(buttonIndex === -1 ? Infinity : buttonIndex)
      expect(middlewareIndex).toBeLessThan(buttonIndex === -1 ? Infinity : buttonIndex)
    })

    it('should rank frontend files higher for UI query', async () => {
      await fs.writeFile(
        path.join(fixture.testDir, 'dashboard.tsx'),
        `// Responsive dashboard with charts and data grid\nexport function Dashboard() {\n  return <div className="dashboard">Charts here</div>\n}`
      )
      await fs.writeFile(
        path.join(fixture.testDir, 'api-handler.ts'),
        `// Handle API requests for user data\nexport function handleRequest(req: any) { return {} }`
      )

      const index = await buildIndex(fixture.testDir)
      const results = score('Build responsive dashboard', index)

      expect(results.length).toBeGreaterThan(0)
      expect(results[0].path).toBe('dashboard.tsx')
    })

    it('should skip node_modules', async () => {
      await fs.mkdir(path.join(fixture.testDir, 'node_modules', 'pkg'), { recursive: true })
      await fs.writeFile(
        path.join(fixture.testDir, 'node_modules', 'pkg', 'index.ts'),
        'export default {}'
      )
      await fs.writeFile(path.join(fixture.testDir, 'app.ts'), 'export function main() {}')

      const index = await buildIndex(fixture.testDir)
      expect(index.totalDocs).toBe(1)
      expect(Object.keys(index.documents)).toContain('app.ts')
    })

    it('should skip .worktrees directory', async () => {
      await fs.mkdir(path.join(fixture.testDir, '.worktrees', 'test-task', 'core'), {
        recursive: true,
      })
      await fs.mkdir(path.join(fixture.testDir, 'core'), { recursive: true })
      await fs.writeFile(
        path.join(fixture.testDir, '.worktrees', 'test-task', 'core', 'auth.ts'),
        'export function login() {}'
      )
      await fs.writeFile(
        path.join(fixture.testDir, 'core', 'auth.ts'),
        'export function login() {}'
      )

      const index = await buildIndex(fixture.testDir)
      const paths = Object.keys(index.documents)
      expect(paths).toContain(path.join('core', 'auth.ts'))
      expect(paths.every((p) => !p.includes('.worktrees'))).toBe(true)
    })

    it('should handle empty query', async () => {
      await fs.writeFile(path.join(fixture.testDir, 'app.ts'), 'export function main() {}')

      const index = await buildIndex(fixture.testDir)
      const results = score('', index)
      expect(results).toEqual([])
    })

    it('should handle empty project', async () => {
      const index = await buildIndex(fixture.testDir)
      expect(index.totalDocs).toBe(0)
      expect(score('anything', index)).toEqual([])
    })
  })
})
