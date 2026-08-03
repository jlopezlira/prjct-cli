import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { indexSymbols } from '../../domain/symbol-graph'
import pathManager from '../../infrastructure/path-manager'
import {
  buildArchitectureSnapshot,
  formatArchitectureMd,
} from '../../services/architecture-snapshot'
import prjctDb from '../../storage/database'

describe('architecture-snapshot', () => {
  let testDir: string
  let testProjectId: string
  const original = pathManager.getGlobalProjectPath.bind(pathManager)

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `prjct-arch-${Date.now()}`)
    testProjectId = `test-arch-${Date.now()}`
    await fs.mkdir(testDir, { recursive: true })
    pathManager.getGlobalProjectPath = () => testDir
  })

  afterEach(async () => {
    pathManager.getGlobalProjectPath = original
    prjctDb.close()
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {})
  })

  it('returns not-ready without index', () => {
    const snap = buildArchitectureSnapshot(testProjectId)
    expect(snap.ready).toBe(false)
  })

  it('summarizes symbols, kinds, and packages after index', async () => {
    await fs.mkdir(path.join(testDir, 'core'), { recursive: true })
    await fs.writeFile(
      path.join(testDir, 'core', 'main.ts'),
      `import { handler } from './router'\nexport function main() { return handler() }\nexport class App {}\n`
    )
    await fs.writeFile(
      path.join(testDir, 'core', 'router.ts'),
      `app.get('/api/users', handler)\nexport function handler() {}\n`
    )
    await indexSymbols(testDir, testProjectId)
    const snap = buildArchitectureSnapshot(testProjectId)
    expect(snap.ready).toBe(true)
    expect(snap.symbols).toBeGreaterThan(0)
    expect(snap.kinds.some((k) => k.kind === 'function')).toBe(true)
    expect(snap.packages).toContain('core')
    expect(snap.hotspots.some((h) => h.file === 'core/router.ts' && h.fanIn === 1)).toBe(true)
    const md = formatArchitectureMd(snap)
    expect(md).toContain('Architecture')
    expect(md).toContain('Symbols')
  })
})
