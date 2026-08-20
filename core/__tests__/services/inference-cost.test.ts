import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import {
  buildInferenceCostReport,
  formatInferenceCostMd,
  type InferenceCostReport,
  parseCostWindow,
  saveInferenceCostSnapshot,
} from '../../services/inference-cost'
import {
  apiCostUsd,
  resetPricingCache,
  resolveModelRate,
  seedPricingCatalog,
} from '../../services/model-pricing'
import { prjctDb } from '../../storage/database'
import { syncPendingStorage } from '../../storage/sync-pending-storage'

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

function insertUsage(opts: {
  id: string
  cycle: string
  source: string
  input: number
  output: number
  model?: string | null
  measuredAt?: number
}): void {
  const now = opts.measuredAt ?? Date.now()
  prjctDb.run(
    fixture.projectId,
    `INSERT INTO token_usage
       (id, work_cycle_id, event_key, source, is_estimated, input_tokens, output_tokens, model_id, measured_at, created_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    opts.id,
    opts.cycle,
    opts.id,
    opts.source,
    opts.input,
    opts.output,
    opts.model ?? null,
    now,
    now
  )
}

const TEST_CATALOG = {
  providers: { xai: { label: 'xAI' }, anthropic: { label: 'Anthropic' } },
  rates: [
    { prefix: 'grok-4.6', provider: 'xai', inputPerMillion: 2, outputPerMillion: 6 },
    { prefix: 'grok-4', provider: 'xai', inputPerMillion: 3, outputPerMillion: 15 },
    { prefix: 'claude-sonnet-5', provider: 'anthropic', inputPerMillion: 2, outputPerMillion: 10 },
    { prefix: 'claude-fable-5', provider: 'anthropic', inputPerMillion: 10, outputPerMillion: 50 },
  ],
}

describe('model pricing', () => {
  afterEach(() => {
    seedPricingCatalog(null)
    resetPricingCache()
  })

  it('prices grok-4.6 at $2/$6 per million, not the legacy grok-4 $3/$15', () => {
    seedPricingCatalog(TEST_CATALOG)
    const grok46 = resolveModelRate('grok-4.6')
    const grok4 = resolveModelRate('grok-4')
    expect(grok46?.provider).toBe('xai')
    expect(grok46?.inputPerMillion).toBe(2)
    expect(grok46?.outputPerMillion).toBe(6)
    expect(grok4?.inputPerMillion).toBe(3)
    expect(grok4?.outputPerMillion).toBe(15)
  })

  it('prices claude-sonnet-5 at the current $2/$10 intro rate', () => {
    seedPricingCatalog(TEST_CATALOG)
    const rate = resolveModelRate('claude-sonnet-5')
    expect(rate?.provider).toBe('anthropic')
    expect(rate?.inputPerMillion).toBe(2)
    expect(rate?.outputPerMillion).toBe(10)
  })

  it('computes API-equivalent dollars from in/out tokens', () => {
    seedPricingCatalog(TEST_CATALOG)
    const rate = resolveModelRate('grok-4.6')
    expect(rate).toBeTruthy()
    // 1M in * $2 + 0.5M out * $6 = $5
    expect(apiCostUsd(1_000_000, 500_000, rate!)).toBe(5)
  })
})

describe('parseCostWindow', () => {
  it('defaults to 7 days', () => {
    expect(parseCostWindow(null, {})).toEqual({ ok: true, days: 7 })
  })

  it('accepts 1..90 and all/history', () => {
    expect(parseCostWindow('14', {})).toEqual({ ok: true, days: 14 })
    expect(parseCostWindow('all', {})).toEqual({ ok: true, days: null })
    expect(parseCostWindow('history', {})).toEqual({ ok: true, days: null })
    expect(parseCostWindow(null, { all: true })).toEqual({ ok: true, days: null })
    expect(parseCostWindow(null, { days: 30 })).toEqual({ ok: true, days: 30 })
  })

  it('rejects windows outside 1..90', () => {
    expect(parseCostWindow('91', {}).ok).toBe(false)
    expect(parseCostWindow('0', {}).ok).toBe(false)
  })
})

describe('inference cost report', () => {
  beforeEach(async () => {
    seedPricingCatalog(TEST_CATALOG)
    fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-inf-root-'))
    fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-inf-project-'))
    fixture.projectId = `inf-${Math.random().toString(36).slice(2, 10)}`
    pathManager.getGlobalProjectPath = (id: string) => path.join(fixture.tmpRoot, id)
    await configManager.writeConfig(fixture.projectPath, {
      projectId: fixture.projectId,
      dataPath: path.join(fixture.tmpRoot, 'data'),
    })
    prjctDb.getDb(fixture.projectId)
  })

  afterEach(async () => {
    seedPricingCatalog(null)
    resetPricingCache()
    prjctDb.close()
    pathManager.getGlobalProjectPath = originalGetGlobalProjectPath
    await fs.rm(fixture.projectPath, { recursive: true, force: true })
    await fs.rm(fixture.tmpRoot, { recursive: true, force: true })
  })

  it('rolls tokens and API dollars up by provider and treats hosted usage as subsidized', () => {
    insertUsage({
      id: 'u-grok',
      cycle: 'c1',
      source: 'grok-transcript:grok-4.6',
      input: 1_000_000,
      output: 500_000,
      model: 'grok-4.6',
    })
    insertUsage({
      id: 'u-claude',
      cycle: 'c2',
      source: 'claude-transcript:claude-sonnet-5',
      input: 200_000,
      output: 50_000,
      model: 'claude-sonnet-5',
    })

    const report = buildInferenceCostReport(fixture.projectId, { days: 7 })
    expect(report.tokensIn).toBe(1_200_000)
    expect(report.tokensOut).toBe(550_000)
    expect(report.apiEquivalentUsd).toBeCloseTo(5.9, 8)
    expect(report.meteredUsd).toBe(0)
    expect(report.subsidizedUsd).toBeCloseTo(5.9, 8)

    const xai = report.byProvider.find((p) => p.provider === 'xai')
    const anthropic = report.byProvider.find((p) => p.provider === 'anthropic')
    expect(xai?.apiEquivalentUsd).toBe(5)
    expect(anthropic?.apiEquivalentUsd).toBeCloseTo(0.9, 8)
    expect(xai?.subsidizedUsd).toBe(5)
  })

  it('ignores estimated context-tax rows that have no model id', () => {
    insertUsage({
      id: 'tax',
      cycle: 'c1',
      source: 'hook-injection:claude',
      input: 1886,
      output: 0,
    })
    insertUsage({
      id: 'grok',
      cycle: 'c1',
      source: 'grok-session:abc',
      input: 1_000_000,
      output: 0,
      model: 'grok-4.6',
    })
    const report = buildInferenceCostReport(fixture.projectId, { days: 7 })
    expect(report.tokensIn).toBe(1_000_000)
    expect(report.byModel.map((m) => m.model)).toEqual(['grok-4.6'])
    expect(report.byProvider.map((p) => p.provider)).toEqual(['xai'])
  })

  it('does not double-count cycle-total rows when per-model rows exist', () => {
    insertUsage({
      id: 'parent',
      cycle: 'c1',
      source: 'grok-transcript',
      input: 1_000_000,
      output: 500_000,
    })
    insertUsage({
      id: 'child',
      cycle: 'c1',
      source: 'grok-transcript:grok-4.6',
      input: 1_000_000,
      output: 500_000,
      model: 'grok-4.6',
    })

    const report = buildInferenceCostReport(fixture.projectId, { days: 7 })
    expect(report.tokensIn).toBe(1_000_000)
    expect(report.tokensOut).toBe(500_000)
    expect(report.apiEquivalentUsd).toBe(5)
  })

  it('includes rows older than 7 days only for the all-history window', () => {
    const fortyDaysAgo = Date.now() - 40 * 86_400_000
    insertUsage({
      id: 'old',
      cycle: 'old',
      source: 'grok-transcript:grok-4.6',
      input: 1_000_000,
      output: 0,
      model: 'grok-4.6',
      measuredAt: fortyDaysAgo,
    })
    insertUsage({
      id: 'new',
      cycle: 'new',
      source: 'grok-transcript:grok-4.6',
      input: 100_000,
      output: 0,
      model: 'grok-4.6',
    })

    const week = buildInferenceCostReport(fixture.projectId, { days: 7 })
    const all = buildInferenceCostReport(fixture.projectId, { days: null })
    expect(week.tokensIn).toBe(100_000)
    expect(all.tokensIn).toBe(1_100_000)
    expect(all.windowDays).toBeNull()
  })

  it('freezes per-model rates into a snapshot (Fable vs Grok, not a provider blend)', async () => {
    insertUsage({
      id: 'u-grok',
      cycle: 'c1',
      source: 'grok-transcript:grok-4.6',
      input: 1_000_000,
      output: 0,
      model: 'grok-4.6',
    })
    insertUsage({
      id: 'u-fable',
      cycle: 'c2',
      source: 'claude-transcript:claude-fable-5',
      input: 1_000_000,
      output: 0,
      model: 'claude-fable-5',
    })
    const report = buildInferenceCostReport(fixture.projectId, { days: 7 })
    await saveInferenceCostSnapshot(fixture.projectId, report)
    const pending = syncPendingStorage.list(fixture.projectId)
    const snap = pending.find((p) => p.event.entityType === 'inference_cost_snapshots')
    expect(snap?.event.entityId).toBe('inference-cost-7d')
    const models = (snap?.event.data as { models: Array<Record<string, unknown>> }).models
    const grok = models.find((m) => m.model === 'grok-4.6')
    const fable = models.find((m) => m.model === 'claude-fable-5')
    expect(grok?.inputPerMillion).toBe(2)
    expect(fable?.inputPerMillion).toBe(10)
    expect(grok?.simulatedUsd).toBe(2)
    expect(fable?.simulatedUsd).toBe(10)
  })
})

function sampleReport(overrides: Partial<InferenceCostReport> = {}): InferenceCostReport {
  return {
    windowDays: 7,
    windowLabel: 'last 7 day(s)',
    generatedAt: '2026-08-19T00:00:00.000Z',
    tokensIn: 1_200_000,
    tokensOut: 550_000,
    tokensTotal: 1_750_000,
    apiEquivalentUsd: 5.9,
    meteredUsd: 0,
    subsidizedUsd: 5.9,
    unpricedTokens: 0,
    byProvider: [
      {
        provider: 'xai',
        providerLabel: 'xAI',
        tokensIn: 1_000_000,
        tokensOut: 500_000,
        tokensTotal: 1_500_000,
        apiEquivalentUsd: 5,
        meteredUsd: 0,
        subsidizedUsd: 5,
        unpricedTokens: 0,
      },
      {
        provider: 'anthropic',
        providerLabel: 'Anthropic',
        tokensIn: 200_000,
        tokensOut: 50_000,
        tokensTotal: 250_000,
        apiEquivalentUsd: 0.9,
        meteredUsd: 0,
        subsidizedUsd: 0.9,
        unpricedTokens: 0,
      },
    ],
    byModel: [
      {
        model: 'grok-4.6',
        provider: 'xai',
        providerLabel: 'xAI',
        tokensIn: 1_000_000,
        tokensOut: 500_000,
        inputPerMillion: 2,
        outputPerMillion: 6,
        apiEquivalentUsd: 5,
      },
      {
        model: 'claude-sonnet-5',
        provider: 'anthropic',
        providerLabel: 'Anthropic',
        tokensIn: 200_000,
        tokensOut: 50_000,
        inputPerMillion: 2,
        outputPerMillion: 10,
        apiEquivalentUsd: 0.9,
      },
    ],
    ...overrides,
  }
}

describe('cost report layout', () => {
  it('simulates cost as tokens × rate per million, then a total when several providers', () => {
    const md = formatInferenceCostMd(sampleReport())
    const xai = md.indexOf('## xAI')
    const anthropic = md.indexOf('## Anthropic')
    const total = md.indexOf('## Total')
    expect(xai).toBeGreaterThan(-1)
    expect(anthropic).toBeGreaterThan(xai)
    expect(total).toBeGreaterThan(anthropic)
    expect(md).toContain('### grok-4.6')
    expect(md).toContain('### claude-sonnet-5')
    expect(md.indexOf('### grok-4.6')).toBeGreaterThan(xai)
    expect(md.indexOf('### grok-4.6')).toBeLessThan(anthropic)
    expect(md.indexOf('### claude-sonnet-5')).toBeGreaterThan(anthropic)
    expect(md).toContain('Total API cost: **$5.00**')
    expect(md).toContain('Total API cost: **$0.90**')
    expect(md).toContain('Total API cost: **$5.90**')
    expect(md).not.toContain('×')
    expect(md).not.toContain('/M')
    expect(md).not.toContain(' + ')
  })

  it('sums each model under a provider instead of averaging rates', () => {
    const md = formatInferenceCostMd(
      sampleReport({
        tokensIn: 2_200_000,
        tokensOut: 550_000,
        tokensTotal: 2_750_000,
        apiEquivalentUsd: 15.9,
        subsidizedUsd: 15.9,
        byProvider: [
          sampleReport().byProvider[0]!,
          {
            provider: 'anthropic',
            providerLabel: 'Anthropic',
            tokensIn: 1_200_000,
            tokensOut: 50_000,
            tokensTotal: 1_250_000,
            apiEquivalentUsd: 10.9,
            meteredUsd: 0,
            subsidizedUsd: 10.9,
            unpricedTokens: 0,
          },
        ],
        byModel: [
          sampleReport().byModel[0]!,
          {
            model: 'claude-fable-5',
            provider: 'anthropic',
            providerLabel: 'Anthropic',
            tokensIn: 1_000_000,
            tokensOut: 0,
            inputPerMillion: 10,
            outputPerMillion: 50,
            apiEquivalentUsd: 10,
          },
          sampleReport().byModel[1]!,
        ],
      })
    )
    expect(md).toContain('### claude-fable-5')
    expect(md).toContain('### claude-sonnet-5')
    expect(md).toContain('Total API cost: **$10.00**')
    expect(md).toContain('Total API cost: **$0.90**')
    expect(md).toContain('Total API cost · Anthropic: **$10.90**')
    expect(md).toContain('Total API cost: **$15.90**')
    expect(md).not.toContain('×')
    expect(md).not.toContain('/M')
    expect(md).not.toContain('$5.45')
  })

  it('skips the Total heading when there is only one provider', () => {
    const one = sampleReport({
      tokensIn: 1_000_000,
      tokensOut: 500_000,
      tokensTotal: 1_500_000,
      apiEquivalentUsd: 5,
      subsidizedUsd: 5,
      byProvider: [sampleReport().byProvider[0]!],
      byModel: [sampleReport().byModel[0]!],
    })
    const md = formatInferenceCostMd(one)
    expect(md).toContain('## xAI')
    expect(md).not.toMatch(/^## Total/m)
  })
})
