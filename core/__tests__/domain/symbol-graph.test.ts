/**
 * Symbol graph — extraction quality, import resolve, CALLS, trace
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  extractFile,
  fileFanIn,
  fileFanInByFile,
  hasSymbolIndex,
  indexSymbols,
  scoreFilesFromQuery,
  searchSymbols,
  stripNoise,
  tracePath,
} from '../../domain/symbol-graph'
import pathManager from '../../infrastructure/path-manager'
import prjctDb from '../../storage/database'

describe('symbol-graph', () => {
  let testDir: string
  let testProjectId: string
  const originalGetGlobalProjectPath = pathManager.getGlobalProjectPath.bind(pathManager)

  beforeEach(async () => {
    testDir = path.join(
      os.tmpdir(),
      `prjct-symbol-graph-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    testProjectId = `test-symbols-${Date.now()}`
    await fs.mkdir(testDir, { recursive: true })
    pathManager.getGlobalProjectPath = () => testDir
  })

  afterEach(async () => {
    pathManager.getGlobalProjectPath = originalGetGlobalProjectPath
    prjctDb.close()
    try {
      await fs.rm(testDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  describe('stripNoise / false positives', () => {
    it('does not extract symbols from string / template literals', () => {
      const content = `
const doc = \`
export function validateUser(id: string) {
  return checkId(id)
}
\`
export function realFn() { return 1 }
`
      const ex = extractFile(content, 'noise.ts')
      const names = ex.symbols.map((s) => s.name)
      expect(names).toContain('realFn')
      expect(names).not.toContain('validateUser')
      expect(names).not.toContain('checkId')
    })

    it('stripNoise preserves newlines (line alignment)', () => {
      const src = 'a\n"hello\\nworld"\nb\n'
      const cleaned = stripNoise(src)
      expect(cleaned.split('\n').length).toBe(src.split('\n').length)
    })
  })

  describe('extractFile', () => {
    it('extracts exported functions and classes from TypeScript', () => {
      const content = `
export function validateUser(id: string) {
  return checkId(id)
}
export class AuthService {
  login() { return validateUser('x') }
}
function checkId(id: string) { return id.length > 0 }
`
      const ex = extractFile(content, 'auth.ts')
      const names = ex.symbols.map((s) => s.name)
      expect(names).toContain('validateUser')
      expect(names).toContain('AuthService')
      expect(names).toContain('checkId')
      expect(ex.callNames).toContain('checkId')
      expect(ex.callNames).toContain('validateUser')
      expect(ex.calls.some((c) => c.name === 'checkId' && c.line > 0)).toBe(true)
    })

    it('extracts named import bindings', () => {
      const content = `import { validate } from './validator'\nexport function run() { validate() }\n`
      const ex = extractFile(content, 'app.ts')
      expect(ex.importBindings.get('validate')).toBe('./validator')
      expect(ex.callNames).toContain('validate')
    })
  })

  describe('index + CALLS quality', () => {
    it('indexes project and finds symbols by name', async () => {
      await fs.writeFile(
        path.join(testDir, 'validator.ts'),
        `export function validate() { return true }\n`
      )
      await fs.writeFile(
        path.join(testDir, 'auth.ts'),
        `import { validate } from './validator'\nexport function login() { return validate() }\n`
      )

      const meta = await indexSymbols(testDir, testProjectId)
      expect(meta.symbolCount).toBeGreaterThan(0)
      expect(hasSymbolIndex(testProjectId)).toBe(true)

      const hits = searchSymbols(testProjectId, 'validate')
      expect(hits.some((h) => h.name === 'validate')).toBe(true)

      const scored = scoreFilesFromQuery(testProjectId, 'login validate')
      expect(scored.length).toBeGreaterThan(0)
      expect(scored.some((s) => s.path.includes('auth') || s.path.includes('validator'))).toBe(true)
    })

    it('traces login as inbound caller of validate (symbol-level CALLS)', async () => {
      await fs.writeFile(
        path.join(testDir, 'validator.ts'),
        `export function validate() { return true }\nexport function normalize() { return true }\n`
      )
      await fs.writeFile(
        path.join(testDir, 'auth.ts'),
        `import { normalize, validate } from './validator'\nexport function login() { return validate() && normalize() }\nexport function admin() { return validate() }\n`
      )
      await fs.writeFile(
        path.join(testDir, 'bootstrap.ts'),
        `import { validate } from './validator'\nconst ready = validate()\nexport { ready }\n`
      )
      await fs.writeFile(
        path.join(testDir, 'isolated.ts'),
        `export function idle() { return true }\n`
      )

      await indexSymbols(testDir, testProjectId)
      const tr = tracePath(testProjectId, 'validate', { direction: 'inbound', depth: 3 })
      expect(tr).not.toBeNull()
      expect(tr!.root.some((r) => r.name === 'validate')).toBe(true)
      // login should appear as a real caller symbol
      expect(tr!.inbound.some((h) => h.symbol.name === 'login')).toBe(true)

      const fanIn = fileFanIn(testProjectId, 'validator.ts')
      // login calls two target symbols but counts once; admin and the
      // top-level file:bootstrap.ts node are two more distinct callers.
      const fanInByFile = fileFanInByFile(testProjectId)
      expect(fanIn).toBe(3)
      expect(fanInByFile.get('validator.ts')).toBe(fanIn)
      expect(fanInByFile.has('isolated.ts')).toBe(false)
    })

    it('resolves @/ and tsconfig paths for CALLS', async () => {
      await fs.mkdir(path.join(testDir, 'src', 'lib'), { recursive: true })
      await fs.writeFile(
        path.join(testDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            baseUrl: '.',
            paths: { '@/*': ['src/*'] },
          },
        })
      )
      await fs.writeFile(
        path.join(testDir, 'src', 'lib', 'util.ts'),
        `export function helper() { return 42 }\n`
      )
      await fs.writeFile(
        path.join(testDir, 'src', 'app.ts'),
        `import { helper } from '@/lib/util'\nexport function main() { return helper() }\n`
      )

      await indexSymbols(testDir, testProjectId)
      const tr = tracePath(testProjectId, 'helper', { direction: 'inbound', depth: 2 })
      expect(tr).not.toBeNull()
      expect(tr!.inbound.some((h) => h.symbol.name === 'main')).toBe(true)
    })

    it('does not invent symbols from test string fixtures', async () => {
      await fs.writeFile(path.join(testDir, 'real.ts'), `export function onlyReal() { return 1 }\n`)
      await fs.writeFile(
        path.join(testDir, 'spec.ts'),
        [
          'const sample = `',
          'export function ghostFn() {}',
          '`',
          'export function realSpec() { return onlyReal() }',
          '',
        ].join('\n')
      )

      await indexSymbols(testDir, testProjectId)
      const ghosts = searchSymbols(testProjectId, 'ghostFn')
      expect(ghosts.filter((g) => g.name === 'ghostFn')).toHaveLength(0)
      expect(searchSymbols(testProjectId, 'onlyReal').some((s) => s.name === 'onlyReal')).toBe(true)
    })
  })
})
