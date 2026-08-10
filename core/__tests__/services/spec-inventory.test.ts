/**
 * spec-inventory tests (Phase 1.6 / B-INV).
 *
 * Exercises:
 *   - Coverage map per module (excluding types/tests/index.ts)
 *   - Drift unknown for shipped specs without shipped_sha (legacy)
 *   - Markdown render shape
 *   - JSON shape (machine-readable for B-JSON consumers)
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildInventory, renderInventoryMd } from '../../services/spec-inventory'
import prjctDb from '../../storage/database'
import { specStorage } from '../../storage/spec-storage'
import { emptySpecContent } from '../../types/spec'

const fixture: {
  projectRoot: string
  projectId: string
  originalProjectsDir: string | undefined
} = {
  projectRoot: '',
  projectId: '',
  originalProjectsDir: undefined as unknown as string | undefined,
}

describe('spec-inventory', () => {
  beforeEach(async () => {
    const tempProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-inv-test-'))
    fixture.originalProjectsDir = process.env.PRJCT_PROJECTS_DIR
    process.env.PRJCT_PROJECTS_DIR = tempProjectsDir

    // Build a fake project tree under projectRoot/core/<module>/
    fixture.projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-inv-proj-'))
    await fs.mkdir(path.join(fixture.projectRoot, 'core', 'sync'), { recursive: true })
    await fs.mkdir(path.join(fixture.projectRoot, 'core', 'auth'), { recursive: true })
    await fs.writeFile(
      path.join(fixture.projectRoot, 'core', 'sync', 'sync-manager.ts'),
      'export const x = 1\n'
    )
    await fs.writeFile(
      path.join(fixture.projectRoot, 'core', 'sync', 'sync-client.ts'),
      'export const y = 2\n'
    )
    await fs.writeFile(
      path.join(fixture.projectRoot, 'core', 'sync', 'types.ts'),
      'export type T = 1\n'
    ) // excluded
    await fs.writeFile(
      path.join(fixture.projectRoot, 'core', 'auth', 'auth-config.ts'),
      'export const z = 3\n'
    )
    await fs.writeFile(path.join(fixture.projectRoot, 'core', 'auth', 'index.ts'), 'export {} \n') // excluded

    fixture.projectId = `inv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    prjctDb.run(fixture.projectId, 'SELECT 1 WHERE 1=0')
  })

  afterEach(async () => {
    if (fixture.originalProjectsDir === undefined) delete process.env.PRJCT_PROJECTS_DIR
    else process.env.PRJCT_PROJECTS_DIR = fixture.originalProjectsDir
    await fs.rm(fixture.projectRoot, { recursive: true, force: true })
  })

  test('coverage map groups specs by module + excludes types/index', async () => {
    const spec = specStorage.create(fixture.projectId, {
      title: 'sync hardening',
      content: {
        ...emptySpecContent('keep sync correct'),
        scope: ['core/sync/sync-manager.ts — bla', 'core/sync/sync-client.ts — bla'],
      },
    })
    expect(spec.id).toBeTruthy()

    const report = await buildInventory(fixture.projectRoot, fixture.projectId)
    const sync = report.modules.find((m) => m.module === 'core/sync')
    expect(sync).toBeTruthy()
    if (!sync) return

    expect(sync.specCount).toBe(1)
    // 2 code files (types.ts excluded)
    expect(sync.totalFiles).toBe(2)
    expect(sync.coveredFiles).toBe(2)
    expect(sync.coveredPct).toBe(100)
  })

  test('uncovered modules listed when no spec mentions them', async () => {
    specStorage.create(fixture.projectId, {
      title: 'sync hardening',
      content: {
        ...emptySpecContent('sync'),
        scope: ['core/sync/sync-manager.ts'],
      },
    })

    const report = await buildInventory(fixture.projectRoot, fixture.projectId)
    expect(report.uncoveredModules).toContain('core/auth')
    expect(report.uncoveredModules).not.toContain('core/sync')
  })

  test('shipped spec without shipped_sha reports drift=unknown', async () => {
    const spec = specStorage.create(fixture.projectId, {
      title: 'shipped legacy',
      content: { ...emptySpecContent('legacy'), scope: ['core/sync/sync-manager.ts'] },
    })
    specStorage.setStatus(fixture.projectId, spec.id, 'shipped')

    const report = await buildInventory(fixture.projectRoot, fixture.projectId)
    const detail = report.driftDetail.find((d) => d.specId === spec.id)
    expect(detail).toBeTruthy()
    expect(detail?.drift).toBe('unknown')
  })

  test('renderInventoryMd produces a Markdown table', async () => {
    specStorage.create(fixture.projectId, {
      title: 'sync',
      content: { ...emptySpecContent('sync'), scope: ['core/sync/sync-manager.ts'] },
    })
    const report = await buildInventory(fixture.projectRoot, fixture.projectId)
    const md = renderInventoryMd(report)
    expect(md).toContain('# Spec inventory')
    expect(md).toContain('## Coverage by module')
    expect(md).toContain('core/sync')
  })

  test('byStatus aggregates spec counts', async () => {
    const a = specStorage.create(fixture.projectId, {
      title: 'A',
      content: emptySpecContent('a'),
    })
    specStorage.create(fixture.projectId, {
      title: 'B',
      content: emptySpecContent('b'),
    })
    specStorage.setStatus(fixture.projectId, a.id, 'shipped')

    const report = await buildInventory(fixture.projectRoot, fixture.projectId)
    expect(report.totalSpecs).toBe(2)
    expect(report.byStatus.draft).toBe(1)
    expect(report.byStatus.shipped).toBe(1)
  })
})
