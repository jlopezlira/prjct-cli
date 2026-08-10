/**
 * Pack marketplace-lite — integrity hash, catalog, verify, install stamps.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import { PACK_MANIFESTS, PACK_NAMES } from '../../packs/manifests'
import {
  buildPackCatalog,
  clearPackInstalls,
  formatPackCatalogMd,
  formatPackVerifyMd,
  loadPackInstalls,
  PACK_INSTALLS_KEY,
  packIntegrityHash,
  stampPackInstalls,
  verifyActivePacks,
} from '../../packs/pack-integrity'
import { activatePacks } from '../../packs/pack-manager'
import prjctDb from '../../storage/database'

const fixture: {
  projectPath: string
  projectId: string
} = {
  projectPath: '',
  projectId: '',
}

async function freshProject(): Promise<void> {
  fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-pack-integrity-'))
  await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
  fixture.projectId = `pack-int-${crypto.randomUUID()}`
  await configManager.writeConfig(fixture.projectPath, {
    projectId: fixture.projectId,
    dataPath: path.join(fixture.projectPath, '.prjct-data'),
    persona: { role: 'DEV', packs: [] },
  } as Parameters<typeof configManager.writeConfig>[1])
  await pathManager.ensureProjectStructure(fixture.projectId)
}

beforeEach(async () => {
  prjctDb.close()
  await freshProject()
})

afterEach(async () => {
  if (fixture.projectPath) {
    await fs.rm(fixture.projectPath, { recursive: true, force: true }).catch(() => {})
  }
  prjctDb.close()
})

describe('packIntegrityHash', () => {
  it('is stable and 16 hex chars for every built-in pack', () => {
    for (const name of PACK_NAMES) {
      const m = PACK_MANIFESTS[name]!
      expect(m.version).toMatch(/^\d+\.\d+\.\d+$/)
      const h = packIntegrityHash(m)
      expect(h).toMatch(/^[a-f0-9]{16}$/)
      expect(packIntegrityHash(m)).toBe(h)
    }
  })

  it('changes when version changes', () => {
    const m = PACK_MANIFESTS.code!
    const a = packIntegrityHash(m)
    const b = packIntegrityHash({ ...m, version: '9.9.9' })
    expect(a).not.toBe(b)
  })
})

describe('stamp / catalog / verify', () => {
  it('activate stamps install receipt', async () => {
    await activatePacks(fixture.projectPath, ['daily'])
    const book = loadPackInstalls(fixture.projectId)
    expect(book.daily).toBeDefined()
    expect(book.daily!.version).toBe(PACK_MANIFESTS.daily!.version)
    expect(book.daily!.integrity).toBe(packIntegrityHash(PACK_MANIFESTS.daily!))
    expect(prjctDb.getDoc(fixture.projectId, PACK_INSTALLS_KEY)).toBeTruthy()
  })

  it('catalog lists all packs with active flag', async () => {
    await activatePacks(fixture.projectPath, ['code'])
    const catalog = await buildPackCatalog(fixture.projectPath)
    expect(catalog.length).toBeGreaterThanOrEqual(PACK_NAMES.length)
    const code = catalog.find((e) => e.name === 'code')
    expect(code?.active).toBe(true)
    expect(code?.status).toBe('active')
    expect(code?.integrity).toMatch(/^[a-f0-9]{16}$/)
    const daily = catalog.find((e) => e.name === 'daily')
    expect(daily?.active).toBe(false)
    expect(daily?.status).toBe('available')
  })

  it('verify ok when receipts match live manifests', async () => {
    await activatePacks(fixture.projectPath, ['daily', 'code'])
    const report = await verifyActivePacks(fixture.projectPath)
    expect(report.ok).toBe(true)
    expect(report.active).toBe(2)
    expect(report.stale).toEqual([])
    expect(report.unknown).toEqual([])
  })

  it('verify flags stale when receipt integrity drifts', async () => {
    await activatePacks(fixture.projectPath, ['daily'])
    const book = loadPackInstalls(fixture.projectId)
    book.daily = {
      ...book.daily!,
      integrity: 'deadbeefdeadbeef',
      version: '0.0.1',
    }
    prjctDb.setDoc(fixture.projectId, PACK_INSTALLS_KEY, book)
    const report = await verifyActivePacks(fixture.projectPath)
    expect(report.ok).toBe(false)
    expect(report.stale).toContain('daily')
  })

  it('clearPackInstalls removes receipt on deactivate path helper', async () => {
    stampPackInstalls(fixture.projectId, ['lean'])
    expect(loadPackInstalls(fixture.projectId).lean).toBeDefined()
    clearPackInstalls(fixture.projectId, ['lean'])
    expect(loadPackInstalls(fixture.projectId).lean).toBeUndefined()
  })
})

describe('formatPackCatalogMd / formatPackVerifyMd', () => {
  it('renders marketplace-lite tables', async () => {
    const catalog = await buildPackCatalog(fixture.projectPath)
    const md = formatPackCatalogMd(catalog)
    expect(md).toContain('marketplace-lite')
    expect(md).toContain('code')
    expect(md).toContain('Integrity')

    await activatePacks(fixture.projectPath, ['daily'])
    const report = await verifyActivePacks(fixture.projectPath)
    const vmd = formatPackVerifyMd(report)
    expect(vmd).toMatch(/OK|Attention/)
    expect(vmd).toContain('daily')
  })
})
