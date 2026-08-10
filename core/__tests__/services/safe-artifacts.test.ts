/**
 * Safe artifact repo — judgment / ships / handoffs / checkpoints facade.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import { createLedger } from '../../services/precision-judgment'
import { formatSafeArtifactsMd, listSafeArtifacts } from '../../services/safe-artifacts'
import prjctDb from '../../storage/database'
import { judgmentLedgerStorage } from '../../storage/judgment-ledger-storage'
import { shippedStorage } from '../../storage/shipped-storage'
import { getTimestamp } from '../../utils/date-helper'

const fixture: {
  projectPath: string
  projectId: string
} = {
  projectPath: '',
  projectId: '',
}

async function freshProject(): Promise<void> {
  fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-artifacts-'))
  await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
  fixture.projectId = `artifacts-${crypto.randomUUID()}`
  await configManager.writeConfig(fixture.projectPath, {
    projectId: fixture.projectId,
    dataPath: path.join(fixture.projectPath, '.prjct-data'),
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

describe('listSafeArtifacts', () => {
  it('returns empty when nothing produced', async () => {
    const r = await listSafeArtifacts(fixture.projectId)
    expect(r.count).toBe(0)
    expect(r.artifacts).toEqual([])
  })

  it('includes active judgment ledger with content hash + gates', async () => {
    const ledger = createLedger({
      target: 'feat/test',
      intensity: 'standard',
      now: getTimestamp(),
    })
    judgmentLedgerStorage.set(fixture.projectId, ledger)
    const r = await listSafeArtifacts(fixture.projectId)
    expect(r.count).toBeGreaterThanOrEqual(1)
    const j = r.artifacts.find((a) => a.kind === 'judgment_ledger')
    expect(j).toBeDefined()
    expect(j!.id).toBe(ledger.id)
    expect(j!.contentHash.length).toBe(16)
    expect(j!.gates.verdict).toBe('in_progress')
    expect(j!.gates.intensity).toBe('standard')
  })

  it('includes ship receipts', async () => {
    await shippedStorage.addShipped(
      fixture.projectId,
      { name: 'context-tiers', version: '1.0.0' },
      getTimestamp()
    )
    const r = await listSafeArtifacts(fixture.projectId)
    const s = r.artifacts.find((a) => a.kind === 'ship_receipt')
    expect(s).toBeDefined()
    expect(s!.summary).toMatch(/context-tiers/)
    expect(s!.gates.version).toBe('1.0.0')
  })

  it('includes context-save checkpoints from disk', async () => {
    const dir = path.join(pathManager.getGlobalProjectPath(fixture.projectId), 'checkpoints')
    await fs.mkdir(dir, { recursive: true })
    const name = '2026-07-11-12-00-00--resume.json'
    await fs.writeFile(
      path.join(dir, name),
      JSON.stringify({
        version: 1,
        title: 'resume mid feature',
        createdAt: '2026-07-11T12:00:00.000Z',
        git: { branch: 'feat/x', head: null, statusShort: [], diffStat: '', recentLog: [] },
        notes: '',
      }),
      'utf-8'
    )
    const r = await listSafeArtifacts(fixture.projectId, { kinds: ['checkpoint'] })
    expect(r.artifacts.some((a) => a.kind === 'checkpoint' && a.id === name)).toBe(true)
  })
})

describe('formatSafeArtifactsMd', () => {
  it('renders table headers', async () => {
    const r = await listSafeArtifacts(fixture.projectId)
    const md = formatSafeArtifactsMd(r)
    expect(md).toContain('# prjct safe artifacts')
    expect(md).toMatch(/No artifacts|Kind/)
  })
})
