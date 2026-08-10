/**
 * Dynasty outcomes — project-scoped closed-loop + vault + tokens for scorecard.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import configManager from '../../infrastructure/config-manager'
import { buildDynastyOutcomes, renderDynastyOutcomesMd } from '../../services/dynasty-outcomes'
import { prjctDb } from '../../storage/database'
import { patchPathManager, restorePathManager } from '../_setup/path-manager-mock'

describe('dynasty-outcomes', () => {
  const fixture: {
    projectPath: string
    projectId: string
  } = {
    projectPath: '',
    projectId: '',
  }

  beforeEach(async () => {
    fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-dynasty-'))
    await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
    fixture.projectId = `dynasty-${Math.random().toString(36).slice(2, 10)}`
    await configManager.writeConfig(fixture.projectPath, {
      projectId: fixture.projectId,
      dataPath: path.join(fixture.projectPath, '.prjct-data'),
    })
    patchPathManager(fixture.projectPath)
    prjctDb.get(fixture.projectId, 'SELECT 1')
  })

  afterEach(async () => {
    restorePathManager()
    if (fixture.projectPath)
      await fs.rm(fixture.projectPath, { recursive: true, force: true }).catch(() => {})
  })

  it('builds scannable outcomes on a fresh project', () => {
    const o = buildDynastyOutcomes(fixture.projectId)
    expect(o.closedLoop.receipts7d).toBeGreaterThanOrEqual(0)
    expect(o.vault.live).toBeGreaterThanOrEqual(0)
    expect(o.tokensSavedTotal).toBeGreaterThanOrEqual(0)
    expect(o.line).toMatch(/Dynasty outcomes/)
    expect(o.rows.length).toBeGreaterThanOrEqual(5)
  })

  it('renders markdown table for harness score', () => {
    const md = renderDynastyOutcomesMd(buildDynastyOutcomes(fixture.projectId))
    expect(md).toContain('Dynasty outcomes')
    expect(md).toContain('Judgment receipts')
    expect(md).toContain('Vault live')
    expect(md).toContain('Tokens saved')
  })
})
