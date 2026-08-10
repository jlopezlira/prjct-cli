import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { indexProject, queryFiles, updateProjectIndex } from '../../domain/bm25'
import { indexImports, loadGraph, updateImportGraph } from '../../domain/import-graph'
import pathManager from '../../infrastructure/path-manager'
import { detectIncrementalChanges } from '../../services/sync/incremental'
import prjctDb from '../../storage/database'

const fixture: {
  projectId: string
  projectPath: string
  originalProjectsDir: string | undefined
  tempProjectsDir: string
} = {
  projectId: '',
  projectPath: '',
  originalProjectsDir: undefined as unknown as string | undefined,
  tempProjectsDir: '',
}

beforeEach(async () => {
  prjctDb.close()
  fixture.tempProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-perf-projects-'))
  fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-perf-worktree-'))
  fixture.originalProjectsDir = process.env.PRJCT_PROJECTS_DIR
  process.env.PRJCT_PROJECTS_DIR = fixture.tempProjectsDir
  fixture.projectId = `perf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await pathManager.ensureProjectStructure(fixture.projectId)
  prjctDb.run(fixture.projectId, 'SELECT 1 WHERE 1=0')
})

afterEach(async () => {
  if (fixture.originalProjectsDir === undefined) delete process.env.PRJCT_PROJECTS_DIR
  else process.env.PRJCT_PROJECTS_DIR = fixture.originalProjectsDir
  prjctDb.close()
  await fs.rm(fixture.tempProjectsDir, { recursive: true, force: true })
  await fs.rm(fixture.projectPath, { recursive: true, force: true })
})

describe('sync incremental performance guards', () => {
  test('BM25 incremental update retokenizes only changed files', async () => {
    await fs.mkdir(path.join(fixture.projectPath, 'src'))
    await fs.writeFile(
      path.join(fixture.projectPath, 'src', 'alpha.ts'),
      'export function alphaSearchTarget() { return true }\n'
    )
    await fs.writeFile(
      path.join(fixture.projectPath, 'src', 'beta.ts'),
      'export function betaBaseline() { return true }\n'
    )

    await indexProject(fixture.projectPath, fixture.projectId)
    await fs.writeFile(
      path.join(fixture.projectPath, 'src', 'beta.ts'),
      'export function betaTelemetryCache() { return true }\n'
    )

    const readSpy = spyOn(fs, 'readFile')
    await updateProjectIndex(fixture.projectPath, fixture.projectId, [path.join('src', 'beta.ts')])

    expect(readSpy).toHaveBeenCalledTimes(1)
    expect(String(readSpy.mock.calls[0]?.[0])).toEndWith(path.join('src', 'beta.ts'))
    expect(queryFiles(fixture.projectId, 'telemetry cache')[0]?.path).toBe(
      path.join('src', 'beta.ts')
    )
    readSpy.mockRestore()
  })

  test('import graph incremental update reparses changed edges without stale reverse links', async () => {
    await fs.mkdir(path.join(fixture.projectPath, 'src'))
    await fs.writeFile(path.join(fixture.projectPath, 'src', 'a.ts'), "import { b } from './b'\n")
    await fs.writeFile(path.join(fixture.projectPath, 'src', 'b.ts'), 'export const b = 1\n')
    await fs.writeFile(path.join(fixture.projectPath, 'src', 'c.ts'), 'export const c = 1\n')

    await indexImports(fixture.projectPath, fixture.projectId)
    await fs.writeFile(path.join(fixture.projectPath, 'src', 'a.ts'), "import { c } from './c'\n")

    const readSpy = spyOn(fs, 'readFile')
    const graph = await updateImportGraph(fixture.projectPath, fixture.projectId, [
      path.join('src', 'a.ts'),
    ])

    expect(readSpy).toHaveBeenCalledTimes(1)
    expect(String(readSpy.mock.calls[0]?.[0])).toEndWith(path.join('src', 'a.ts'))
    expect(graph.forward[path.join('src', 'a.ts')]).toEqual([path.join('src', 'c.ts')])
    expect(graph.reverse[path.join('src', 'b.ts')]).toBeUndefined()
    expect(graph.reverse[path.join('src', 'c.ts')]).toContain(path.join('src', 'a.ts'))
    expect(loadGraph(fixture.projectId)?.forward[path.join('src', 'a.ts')]).toEqual([
      path.join('src', 'c.ts'),
    ])
    readSpy.mockRestore()
  })

  test('import graph incremental update removes deleted target edges from importers and storage', async () => {
    await fs.mkdir(path.join(fixture.projectPath, 'src'))
    await fs.writeFile(path.join(fixture.projectPath, 'src', 'a.ts'), "import { b } from './b'\n")
    await fs.writeFile(path.join(fixture.projectPath, 'src', 'b.ts'), 'export const b = 1\n')

    await indexImports(fixture.projectPath, fixture.projectId)
    await fs.rm(path.join(fixture.projectPath, 'src', 'b.ts'))

    const graph = await updateImportGraph(
      fixture.projectPath,
      fixture.projectId,
      [],
      [path.join('src', 'b.ts')]
    )

    expect(graph.forward[path.join('src', 'a.ts')]).toBeUndefined()
    expect(graph.reverse[path.join('src', 'b.ts')]).toBeUndefined()
    expect(loadGraph(fixture.projectId)?.forward[path.join('src', 'a.ts')]).toBeUndefined()
    expect(loadGraph(fixture.projectId)?.reverse[path.join('src', 'b.ts')]).toBeUndefined()
  })

  test('no-change incremental detection reuses stored checksums without reading file contents', async () => {
    await fs.mkdir(path.join(fixture.projectPath, 'src'))
    for (const i of Array.from({ length: 20 }, (_, index) => index)) {
      await fs.writeFile(
        path.join(fixture.projectPath, 'src', `file-${i}.ts`),
        `export const v${i} = ${i}\n`
      )
    }

    await detectIncrementalChanges({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      isFullSync: false,
      changedFilesHint: undefined,
    })

    const readSpy = spyOn(fs, 'readFile')
    const result = await detectIncrementalChanges({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      isFullSync: false,
      changedFilesHint: undefined,
    })

    expect(result.incrementalInfo?.filesChanged).toBe(0)
    expect(result.shouldRebuildIndexes).toBe(false)
    expect(readSpy).not.toHaveBeenCalled()
    readSpy.mockRestore()
  })
})
