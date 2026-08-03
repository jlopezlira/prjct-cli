import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { hasSymbolIndex, indexSymbols, listAllSymbols } from '../../domain/symbol-graph'
import pathManager from '../../infrastructure/path-manager'
import {
  artifactPath,
  exportCodeGraphArtifact,
  importCodeGraphArtifact,
  maybeExportAfterIndex,
  shouldAutoUploadCodeGraph,
} from '../../services/code-graph-artifact'
import prjctDb from '../../storage/database'

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

describe('code-graph-artifact', () => {
  let testDir: string
  let testProjectId: string
  let sourceDir: string
  const originalGet = pathManager.getGlobalProjectPath.bind(pathManager)

  beforeEach(async () => {
    testDir = path.join(
      os.tmpdir(),
      `prjct-artifact-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    sourceDir = path.join(testDir, 'src-repo')
    testProjectId = `test-artifact-${Date.now()}`
    await fs.mkdir(sourceDir, { recursive: true })
    // Project storage (where artifact MUST live) separate from client source
    pathManager.getGlobalProjectPath = (id: string) => path.join(testDir, 'projects', id)
  })

  afterEach(async () => {
    pathManager.getGlobalProjectPath = originalGet
    prjctDb.close()
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {})
  })

  it('exports under projects/<id>/ — never into client source tree', async () => {
    await fs.writeFile(
      path.join(sourceDir, 'svc.ts'),
      `export function doWork() { return 1 }\nexport class Svc {}\n`
    )
    await indexSymbols(sourceDir, testProjectId)
    const before = listAllSymbols(testProjectId).length
    expect(before).toBeGreaterThan(0)

    const exp = await exportCodeGraphArtifact(testProjectId)
    expect(exp).not.toBeNull()
    expect(exp!.bytes).toBeGreaterThan(20)
    expect(exp!.path).toBe(artifactPath(testProjectId))
    // Must NOT appear under the client source tree
    expect(await exists(path.join(sourceDir, 'code-graph.json.gz'))).toBe(false)
    expect(await exists(path.join(sourceDir, '.prjct', 'code-graph.json.gz'))).toBe(false)
    // Must exist under project storage
    expect(await exists(artifactPath(testProjectId))).toBe(true)
    // Path must not be under sourceDir
    expect(exp!.path.startsWith(sourceDir)).toBe(false)
    expect(exp!.path.includes(path.join('projects', testProjectId))).toBe(true)

    // Wipe SQLite index
    prjctDb.transaction(testProjectId, (db) => {
      db.prepare('DELETE FROM code_symbols').run()
      db.prepare('DELETE FROM code_symbol_edges').run()
    })
    expect(hasSymbolIndex(testProjectId)).toBe(false)

    const imp = await importCodeGraphArtifact(testProjectId)
    expect(imp.imported).toBe(true)
    expect(listAllSymbols(testProjectId).length).toBe(before)
  })

  it('refuses restore when artifact projectId mismatches', async () => {
    await fs.writeFile(path.join(sourceDir, 'svc.ts'), `export function doWork() { return 1 }\n`)
    const meta = await indexSymbols(sourceDir, testProjectId)
    expect(meta.symbolCount).toBeGreaterThan(0)
    expect(hasSymbolIndex(testProjectId)).toBe(true)

    const exp = await exportCodeGraphArtifact(testProjectId)
    expect(exp).not.toBeNull()
    expect(await exists(artifactPath(testProjectId))).toBe(true)

    const otherId = `${testProjectId}-other`
    await fs.mkdir(path.dirname(artifactPath(otherId)), { recursive: true })
    await fs.copyFile(artifactPath(testProjectId), artifactPath(otherId))
    const imp = await importCodeGraphArtifact(otherId)
    expect(imp.imported).toBe(false)
    expect(imp.reason).toMatch(/mismatch/)
  })

  it('gates automatic cloud upload on enabled and active local config', () => {
    expect(shouldAutoUploadCodeGraph(undefined)).toBe(false)
    expect(shouldAutoUploadCodeGraph({ cloud: { enabled: false } })).toBe(false)
    expect(shouldAutoUploadCodeGraph({ cloud: { enabled: true, paused: true } })).toBe(false)
    expect(shouldAutoUploadCodeGraph({ cloud: { enabled: true, paused: false } })).toBe(true)
    expect(shouldAutoUploadCodeGraph({ cloud: { enabled: true } })).toBe(true)
  })

  it('always exports a restorable local artifact without building or uploading cloud graph', async () => {
    await fs.writeFile(path.join(sourceDir, 'svc.ts'), `export function localOnly() { return 1 }\n`)
    await indexSymbols(sourceDir, testProjectId)
    const before = listAllSymbols(testProjectId).length
    let buildCalls = 0
    let uploadCalls = 0

    await maybeExportAfterIndex(testProjectId, {
      uploadToCloud: shouldAutoUploadCodeGraph(undefined),
      uploadDependencies: {
        buildSnapshot: () => {
          buildCalls++
          throw new Error('cloud snapshot must not build for local-only config')
        },
        upload: async () => {
          uploadCalls++
          return { ok: true }
        },
      },
    })

    expect(buildCalls).toBe(0)
    expect(uploadCalls).toBe(0)
    expect(await exists(artifactPath(testProjectId))).toBe(true)

    prjctDb.transaction(testProjectId, (db) => {
      db.prepare('DELETE FROM code_symbols').run()
      db.prepare('DELETE FROM code_symbol_edges').run()
    })
    const restored = await importCodeGraphArtifact(testProjectId)
    expect(restored.imported).toBe(true)
    expect(listAllSymbols(testProjectId)).toHaveLength(before)
  })

  it('uploads exactly one complete snapshot when cloud is enabled and active', async () => {
    await fs.writeFile(
      path.join(sourceDir, 'svc.ts'),
      `export function first() { return second() }\nexport function second() { return 2 }\n`
    )
    const meta = await indexSymbols(sourceDir, testProjectId)
    let uploadCalls = 0
    let uploadedNodes = 0
    let uploadedSymbols = 0

    await maybeExportAfterIndex(testProjectId, {
      uploadToCloud: shouldAutoUploadCodeGraph({ cloud: { enabled: true } }),
      uploadDependencies: {
        upload: async (_projectId, graph) => {
          uploadCalls++
          uploadedNodes = graph.nodes.length
          uploadedSymbols = graph.nodes.filter((node) => node.kind !== 'File').length
          return { ok: true, nodes: graph.nodes.length, links: graph.links.length }
        },
      },
    })

    expect(uploadCalls).toBe(1)
    expect(uploadedNodes).toBeGreaterThanOrEqual(meta.symbolCount)
    expect(uploadedSymbols).toBe(meta.symbolCount)
    expect(await exists(artifactPath(testProjectId))).toBe(true)
  })
})
