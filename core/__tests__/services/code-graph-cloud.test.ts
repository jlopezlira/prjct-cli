import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { indexSymbols } from '../../domain/symbol-graph'
import pathManager from '../../infrastructure/path-manager'
import { buildCloudCodeGraphSnapshot, isUploadableGraph } from '../../services/code-graph-cloud'
import prjctDb from '../../storage/database'

describe('code-graph-cloud compact structural snapshot', () => {
  const fixture: {
    testDir: string
    testProjectId: string
    sourceDir: string
  } = {
    testDir: '',
    testProjectId: '',
    sourceDir: '',
  }

  const originalGet = pathManager.getGlobalProjectPath.bind(pathManager)

  beforeEach(async () => {
    fixture.testDir = path.join(
      os.tmpdir(),
      `prjct-cloud-graph-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    fixture.sourceDir = path.join(fixture.testDir, 'src-repo')
    fixture.testProjectId = `test-cloud-graph-${Date.now()}`
    await fs.mkdir(path.join(fixture.sourceDir, 'src'), { recursive: true })
    pathManager.getGlobalProjectPath = (id: string) => path.join(fixture.testDir, 'projects', id)

    await fs.writeFile(
      path.join(fixture.sourceDir, 'src', 'svc.ts'),
      `
export class Service {
  run() {
    return helper()
  }
}
export function helper() {
  return 1
}
export function unused() {
  return 2
}
`
    )
    await fs.writeFile(
      path.join(fixture.sourceDir, 'src', 'main.ts'),
      `
import { Service } from './svc'
export function main() {
  const s = new Service()
  return s.run()
}
`
    )
  })

  afterEach(async () => {
    pathManager.getGlobalProjectPath = originalGet
    try {
      prjctDb.close(fixture.testProjectId)
    } catch {
      /* ok */
    }
    await fs.rm(fixture.testDir, { recursive: true, force: true })
  })

  it('builds Function/Class/File nodes with structural edges (not knowledge)', async () => {
    await indexSymbols(fixture.sourceDir, fixture.testProjectId)
    const snap = buildCloudCodeGraphSnapshot(fixture.testProjectId)
    expect(isUploadableGraph(snap)).toBe(true)
    expect(snap!.version).toBe(1)
    expect(snap!.nodes.length).toBeGreaterThan(0)

    const kinds = new Set(snap!.nodes.map((n) => n.kind))
    // Must be structural kinds only
    for (const k of kinds) {
      expect([
        'Function',
        'Method',
        'Class',
        'Interface',
        'Type',
        'Enum',
        'Const',
        'Route',
        'File',
        'Symbol',
      ]).toContain(k)
    }
    expect(kinds.has('Function') || kinds.has('Class') || kinds.has('Method')).toBe(true)

    // No contribution/knowledge fake hubs
    expect(snap!.nodes.every((n) => n.kind !== 'knowledge' && n.kind !== 'project')).toBe(true)

    const types = new Set(snap!.links.map((l) => l.type))
    // At least DEFINES (file→symbol) or CALLS/IMPORTS when resolvable
    expect(types.size).toBeGreaterThan(0)
    for (const t of types) {
      expect(['CALLS', 'IMPORTS', 'DEFINES', 'HANDLES', 'TESTS']).toContain(t)
    }
  })

  it('returns null without symbol index', () => {
    expect(buildCloudCodeGraphSnapshot('no-such-project-xyz')).toBeNull()
  })

  it('optional maxNodes/maxLinks only apply when explicitly passed', async () => {
    await indexSymbols(fixture.sourceDir, fixture.testProjectId)
    const full = buildCloudCodeGraphSnapshot(fixture.testProjectId)
    const capped = buildCloudCodeGraphSnapshot(fixture.testProjectId, { maxNodes: 3, maxLinks: 20 })
    expect(full).not.toBeNull()
    expect(capped).not.toBeNull()
    // Default ships the full index (no artificial 400/900 cloud caps)
    expect(full!.nodes.length).toBeGreaterThanOrEqual(capped!.nodes.length)
    // Opt-in cap still bounds picked symbols (+ file hubs)
    expect(capped!.nodes.length).toBeLessThanOrEqual(10)
    expect(capped!.links.length).toBeLessThanOrEqual(20)
  })

  it('default snapshot includes every indexed symbol as a node (no drop)', async () => {
    await indexSymbols(fixture.sourceDir, fixture.testProjectId)
    const snap = buildCloudCodeGraphSnapshot(fixture.testProjectId)
    expect(snap).not.toBeNull()
    // symbolCount is the index size; nodes = symbols + File hubs (≥ symbolCount)
    expect(snap!.nodes.length).toBeGreaterThanOrEqual(snap!.symbolCount)
    const nonFile = snap!.nodes.filter((n) => n.kind !== 'File')
    expect(nonFile.length).toBe(snap!.symbolCount)
  })
})
