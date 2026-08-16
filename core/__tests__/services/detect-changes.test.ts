/**
 * detect_changes — risk classification + blast radius
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { indexImports } from '../../domain/import-graph'
import { indexSymbols } from '../../domain/symbol-graph'
import pathManager from '../../infrastructure/path-manager'
import { detectChanges } from '../../services/detect-changes'
import prjctDb from '../../storage/database'
import { execFileAsync, GitInfraError } from '../../utils/exec'

describe('detect-changes', () => {
  const fixture: {
    testDir: string
    testProjectId: string
  } = {
    testDir: '',
    testProjectId: '',
  }

  const originalGetGlobalProjectPath = pathManager.getGlobalProjectPath.bind(pathManager)

  beforeEach(async () => {
    fixture.testDir = path.join(os.tmpdir(), `prjct-detect-changes-${Date.now()}`)
    fixture.testProjectId = `test-detect-${Date.now()}`
    await fs.mkdir(fixture.testDir, { recursive: true })
    pathManager.getGlobalProjectPath = () => fixture.testDir
  })

  afterEach(async () => {
    pathManager.getGlobalProjectPath = originalGetGlobalProjectPath
    prjctDb.close()
    try {
      await fs.rm(fixture.testDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('classifies explicit changed files with import blast radius', async () => {
    await fs.writeFile(path.join(fixture.testDir, 'core.ts'), `export function core() {}\n`)
    await fs.writeFile(
      path.join(fixture.testDir, 'app.ts'),
      `import { core } from './core'\nexport function app() { return core() }\n`
    )
    await indexImports(fixture.testDir, fixture.testProjectId)
    await indexSymbols(fixture.testDir, fixture.testProjectId)

    const result = await detectChanges(fixture.testDir, fixture.testProjectId, {
      files: ['core.ts'],
    })

    expect(result.changedFiles).toEqual(['core.ts'])
    expect(result.affectedFiles).toContain('core.ts')
    // app imports core → in blast radius
    expect(result.affectedFiles).toContain('app.ts')
    expect(result.changes[0]?.file).toBe('core.ts')
    expect(['critical', 'high', 'medium', 'low']).toContain(result.changes[0]!.risk)
  })

  it('flags auth path as elevated risk', async () => {
    await fs.mkdir(path.join(fixture.testDir, 'auth'), { recursive: true })
    await fs.writeFile(
      path.join(fixture.testDir, 'auth', 'login.ts'),
      `export function login() {}\n`
    )
    await indexSymbols(fixture.testDir, fixture.testProjectId)

    const result = await detectChanges(fixture.testDir, fixture.testProjectId, {
      files: ['auth/login.ts'],
    })
    expect(result.changes[0]?.risk).toBe('critical')
    expect(result.summary.critical).toBe(1)
  })

  it('caches the blast-radius result for an unchanged diff — a second call (e.g. `ship` then `code impact`) against the same diff does not re-walk', async () => {
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: fixture.testDir })
    await execFileAsync('git', ['config', 'user.email', 't@example.com'], { cwd: fixture.testDir })
    await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: fixture.testDir })
    await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: fixture.testDir })
    await fs.writeFile(path.join(fixture.testDir, '.gitignore'), 'prjct.db*\n')
    await fs.writeFile(path.join(fixture.testDir, 'core.ts'), `export function core() {}\n`)
    await execFileAsync('git', ['add', '.'], { cwd: fixture.testDir })
    await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: fixture.testDir })

    // Uncommitted change — this is the diff detectChanges observes.
    await fs.writeFile(
      path.join(fixture.testDir, 'core.ts'),
      `export function core() { return 1 }\n`
    )
    await indexSymbols(fixture.testDir, fixture.testProjectId)
    await indexImports(fixture.testDir, fixture.testProjectId)

    const first = await detectChanges(fixture.testDir, fixture.testProjectId, {
      source: 'working-tree',
    })
    expect(first.changedFiles).toEqual(['core.ts'])
    expect(first.affectedFiles).not.toContain('app.ts')

    // Add a NEW importer of core.ts and commit it immediately — it's fully
    // tracked/clean, so it does NOT appear in the working-tree diff (the
    // uncommitted edit to core.ts is still the only diff content, so the
    // signature is unchanged). A fresh (uncached) re-walk would now see
    // app.ts in the import graph and include it in blast radius; a cache
    // hit — keyed on the diff signature, not the import graph — must not.
    await fs.writeFile(
      path.join(fixture.testDir, 'app.ts'),
      `import { core } from './core'\nexport function app() { return core() }\n`
    )
    await execFileAsync('git', ['add', 'app.ts'], { cwd: fixture.testDir })
    await execFileAsync('git', ['commit', '-q', '-m', 'add app.ts'], { cwd: fixture.testDir })
    await indexImports(fixture.testDir, fixture.testProjectId)

    const second = await detectChanges(fixture.testDir, fixture.testProjectId, {
      source: 'working-tree',
    })
    expect(second).toEqual(first)
    expect(second.affectedFiles).not.toContain('app.ts')
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

describe('detect-changes — typed git failures (WS1)', () => {
  it('git infra failure rejects with GitInfraError instead of a fake clean tree', async () => {
    if (process.platform === 'win32') return
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-dc-nogit-'))
    try {
      await withBrokenGit(async () => {
        await expect(
          detectChanges(dir, 'test-dc-nogit', { source: 'working-tree' })
        ).rejects.toBeInstanceOf(GitInfraError)
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
