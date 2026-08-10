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
  const fixture: {
    testDir: string
    testProjectId: string
  } = {
    testDir: '',
    testProjectId: '',
  }

  const original = pathManager.getGlobalProjectPath.bind(pathManager)

  beforeEach(async () => {
    fixture.testDir = path.join(os.tmpdir(), `prjct-arch-${Date.now()}`)
    fixture.testProjectId = `test-arch-${Date.now()}`
    await fs.mkdir(fixture.testDir, { recursive: true })
    pathManager.getGlobalProjectPath = () => fixture.testDir
  })

  afterEach(async () => {
    pathManager.getGlobalProjectPath = original
    prjctDb.close()
    await fs.rm(fixture.testDir, { recursive: true, force: true }).catch(() => {})
  })

  it('returns not-ready without index', () => {
    const snap = buildArchitectureSnapshot(fixture.testProjectId)
    expect(snap.ready).toBe(false)
  })

  it('summarizes symbols, kinds, and packages after index', async () => {
    await fs.mkdir(path.join(fixture.testDir, 'core'), { recursive: true })
    await fs.writeFile(
      path.join(fixture.testDir, 'core', 'main.ts'),
      `import { handler } from './router'\nexport function main() { return handler() }\nexport class App {}\n`
    )
    await fs.writeFile(
      path.join(fixture.testDir, 'core', 'router.ts'),
      `app.get('/api/users', handler)\nexport function handler() {}\n`
    )
    await indexSymbols(fixture.testDir, fixture.testProjectId)
    const snap = buildArchitectureSnapshot(fixture.testProjectId)
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
