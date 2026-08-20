import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ProductCommands } from '../../commands/product'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import { resetPricingCache, seedPricingCatalog } from '../../services/model-pricing'
import { prjctDb } from '../../storage/database'

const fixture: {
  projectPath: string
  tmpRoot: string
  projectId: string
} = {
  projectPath: '',
  tmpRoot: '',
  projectId: '',
}

const originalGetGlobalProjectPath = pathManager.getGlobalProjectPath.bind(pathManager)

describe('prjct cost', () => {
  beforeEach(async () => {
    fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-cost-cmd-root-'))
    fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-cost-cmd-project-'))
    fixture.projectId = `costcmd-${Math.random().toString(36).slice(2, 10)}`
    pathManager.getGlobalProjectPath = (id: string) => path.join(fixture.tmpRoot, id)
    await configManager.writeConfig(fixture.projectPath, {
      projectId: fixture.projectId,
      dataPath: path.join(fixture.tmpRoot, 'data'),
    })
    prjctDb.getDb(fixture.projectId)
    seedPricingCatalog({
      providers: { xai: { label: 'xAI' } },
      rates: [{ prefix: 'grok-4.6', provider: 'xai', inputPerMillion: 2, outputPerMillion: 6 }],
    })
  })

  afterEach(async () => {
    seedPricingCatalog(null)
    resetPricingCache()
    prjctDb.close()
    pathManager.getGlobalProjectPath = originalGetGlobalProjectPath
    await fs.rm(fixture.projectPath, { recursive: true, force: true })
    await fs.rm(fixture.tmpRoot, { recursive: true, force: true })
  })

  it('prints API-equivalent and subsidized totals for the default 7-day window', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {})
    const now = Date.now()
    try {
      prjctDb.run(
        fixture.projectId,
        `INSERT INTO token_usage
           (id, work_cycle_id, event_key, source, is_estimated, input_tokens, output_tokens, model_id, measured_at, created_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
        'u1',
        'c1',
        'u1',
        'grok-transcript:grok-4.6',
        1_000_000,
        500_000,
        'grok-4.6',
        now,
        now
      )

      const result = await new ProductCommands().cost(null, fixture.projectPath, { md: true })
      expect(result.success).toBe(true)
      expect(result.apiEquivalentUsd).toBe(5)
      expect(result.subsidizedUsd).toBe(5)
      expect(result.windowDays).toBe(7)

      const printed = log.mock.calls.map((c) => String(c[0])).join('\n')
      expect(printed).toContain('Cost simulation')
      expect(printed).toContain('## xAI')
      expect(printed).toContain('### grok-4.6')
      expect(printed).toContain('Total API cost: **$5.00**')
      expect(printed).not.toContain('×')
      expect(printed).not.toContain('/M')
      expect(printed).not.toMatch(/^## Total/m)
    } finally {
      log.mockRestore()
    }
  })

  it('rejects windows above 90 days', async () => {
    const result = await new ProductCommands().cost('91', fixture.projectPath, { md: true })
    expect(result.success).toBe(false)
    expect(String(result.error)).toMatch(/1.*90|all/i)
  })
})
