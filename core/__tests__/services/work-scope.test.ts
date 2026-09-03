import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { MemoryEntry } from '../../memory/entries'
import { refreshFileInventory } from '../../services/project-file-inventory'
import {
  extractFilePathsFromEntries,
  formatWorkScopeBlock,
  isUsefulScopePath,
  resolveWorkScope,
  resolveWorkScopeSync,
} from '../../services/work-scope'
import { prjctDb } from '../../storage/database'

describe('extractFilePathsFromEntries — inventory-driven', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const r of roots) {
      try {
        fs.rmSync(r, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
    roots.length = 0
  })

  test('pulls tags and paths filtered by project inventory (any language in tree)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prjct-ws-'))
    roots.push(root)
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    fs.mkdirSync(path.join(root, 'app', 'models'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src', 'App.vue'), '<template/>')
    fs.writeFileSync(path.join(root, 'app', 'models', 'user.rb'), 'class User; end')
    fs.writeFileSync(path.join(root, 'core.ts'), 'export {}')

    const projectId = randomUUID()
    prjctDb.getDoc(projectId, 'project')
    await refreshFileInventory(projectId, root)

    const entries = [
      {
        id: 'mem_1',
        type: 'gotcha',
        content: 'See src/App.vue and app/models/user.rb — also missing Main.java',
        tags: { file: 'core.ts' },
        rememberedAt: new Date().toISOString(),
        provenance: 'declared',
      },
    ] as MemoryEntry[]

    const paths = extractFilePathsFromEntries(entries, projectId)
    expect(paths).toContain('src/App.vue')
    expect(paths).toContain('app/models/user.rb')
    expect(paths).toContain('core.ts')
    // bare Main.java lacks dir/ — REPO_PATH_RE may not capture; if captured, still accepted (downrank only)
  })

  test('isUsefulScopePath accepts unknown ext (downrank in ranking, no hard drop)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prjct-ws2-'))
    roots.push(root)
    fs.mkdirSync(path.join(root, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(root, 'lib', 'x.go'), 'package lib')
    const projectId = randomUUID()
    prjctDb.getDoc(projectId, 'project')
    await refreshFileInventory(projectId, root)
    expect(isUsefulScopePath('lib/x.go', projectId)).toBe(true)
    expect(isUsefulScopePath('pkg/Main.java', projectId)).toBe(true)
  })
})

describe('formatWorkScopeBlock', () => {
  test('empty cold indexes points at sync', () => {
    const block = formatWorkScopeBlock([], { indexesReady: false })
    expect(block).toContain('prjct sync')
    expect(block).toMatch(/Grep|Glob/i)
  })

  test('non-empty lists MUST discipline', () => {
    const block = formatWorkScopeBlock([
      {
        path: 'core/hooks/pre-edit.ts',
        signals: ['bm25', 'imports'],
        reason: 'matches task terms',
        score: 1,
      },
    ])
    expect(block).toContain('MUST')
    expect(block).toContain('pre-edit.ts')
    expect(block).toContain('Grep/Glob')
  })
})

describe('resolveWorkScopeSync', () => {
  test('empty query → empty files', () => {
    const r = resolveWorkScopeSync('00000000-0000-0000-0000-000000000000', '   ')
    expect(r.files).toEqual([])
  })

  test('returns shape for unknown project without throw', () => {
    const r = resolveWorkScopeSync(
      '00000000-0000-0000-0000-000000000000',
      'pre-edit conflict gate judgment'
    )
    expect(r.sources).toBeDefined()
    expect(Array.isArray(r.files)).toBe(true)
    expect(typeof r.agentBlock).toBe('string')
  })
})

describe('resolveWorkScope — caller-supplied memory hits', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const r of roots) {
      try {
        fs.rmSync(r, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
    roots.length = 0
  })

  test('seeds the scope from the supplied hits without re-running recall', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prjct-ws3-'))
    roots.push(root)
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src', 'App.vue'), '<template/>')
    fs.writeFileSync(path.join(root, 'core.ts'), 'export {}')
    const projectId = randomUUID()
    prjctDb.getDoc(projectId, 'project')
    await refreshFileInventory(projectId, root)

    const now = new Date().toISOString()
    const memoryHits = [
      {
        id: 'mem_seed',
        type: 'gotcha',
        content: 'The template in src/App.vue re-renders on every store write',
        tags: {},
        rememberedAt: now,
        provenance: 'declared',
      },
      {
        // Outside the scope's semantic types: must not seed.
        id: 'mem_fact',
        type: 'fact',
        content: 'core.ts is the entry point',
        tags: {},
        rememberedAt: now,
        provenance: 'declared',
      },
    ] as MemoryEntry[]

    const scope = await resolveWorkScope(root, projectId, 'store write re-render', 8, {
      memoryHits,
    })
    const paths = scope.files.map((f) => f.path)
    expect(paths).toContain('src/App.vue')
    expect(paths).not.toContain('core.ts')
    expect(scope.sources.memorySeeds).toBeGreaterThanOrEqual(1)
  })
})
