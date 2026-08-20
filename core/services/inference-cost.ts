import prjctDb from '../storage/database'
import { query } from '../storage/query-helpers'
import { publishCRUD } from '../sync/publish-helper'
import {
  apiCostUsd,
  ensurePricingCatalog,
  formatUsd,
  type ProviderId,
  providerFromSource,
  providerLabel,
  resolveModelRate,
} from './model-pricing'

export interface CostWindowOptions {
  /** `null` = all recorded history. */
  days: number | null
}

export type CostWindowParse = { ok: true; days: number | null } | { ok: false; error: string }

const WINDOW_ERROR = 'Window must be 1–90 days, or `all` for complete history.'

export function parseCostWindow(
  input: string | null | undefined,
  options: { days?: number; all?: boolean } = {}
): CostWindowParse {
  if (options.all) return { ok: true, days: null }
  const raw = (input ?? '').trim()
  if (/\b(all|history|full)\b/i.test(raw)) return { ok: true, days: null }
  if (typeof options.days === 'number' && Number.isFinite(options.days)) {
    const n = Math.floor(options.days)
    if (n < 1 || n > 90) return { ok: false, error: WINDOW_ERROR }
    return { ok: true, days: n }
  }
  const match = raw.match(/\b(\d{1,3})\b/)
  if (!match) {
    if (!raw) return { ok: true, days: 7 }
    return { ok: false, error: WINDOW_ERROR }
  }
  const n = Number.parseInt(match[1]!, 10)
  if (n < 1 || n > 90) return { ok: false, error: WINDOW_ERROR }
  return { ok: true, days: n }
}

export interface InferenceCostSlice {
  provider: ProviderId
  providerLabel: string
  tokensIn: number
  tokensOut: number
  tokensTotal: number
  apiEquivalentUsd: number
  meteredUsd: number
  subsidizedUsd: number
  unpricedTokens: number
}

export interface InferenceCostModelSlice {
  model: string
  provider: ProviderId
  providerLabel: string
  tokensIn: number
  tokensOut: number
  inputPerMillion: number | null
  outputPerMillion: number | null
  apiEquivalentUsd: number | null
}

export interface InferenceCostReport {
  windowDays: number | null
  windowLabel: string
  generatedAt: string
  tokensIn: number
  tokensOut: number
  tokensTotal: number
  apiEquivalentUsd: number
  meteredUsd: number
  subsidizedUsd: number
  unpricedTokens: number
  byProvider: InferenceCostSlice[]
  byModel: InferenceCostModelSlice[]
}

interface UsageRow {
  work_cycle_id: string | null
  source: string | null
  model_id: string | null
  input_tokens: number
  output_tokens: number
}

function sinceMs(days: number | null): number {
  if (days === null) return 0
  return Date.now() - days * 86_400_000
}

function windowLabel(days: number | null): string {
  return days === null ? 'all recorded history' : `last ${days} day(s)`
}

/**
 * Prefer per-model rows. Cycle-total rows (no model_id) are kept only for
 * cycles that have no per-model breakdown, taking the fattest source so
 * cli + transcript totals of the same session are not summed twice.
 */
function selectRows(rows: UsageRow[]): UsageRow[] {
  const cyclesWithModel = new Set(rows.filter((r) => r.model_id).map((r) => r.work_cycle_id ?? ''))
  const noModelByCycle = new Map<string, UsageRow>()
  const withModel: UsageRow[] = []
  for (const row of rows) {
    if (row.model_id) {
      withModel.push(row)
      continue
    }
    const cycle = row.work_cycle_id ?? row.source ?? 'unknown'
    if (cyclesWithModel.has(row.work_cycle_id ?? '')) continue
    const prev = noModelByCycle.get(cycle)
    const total = (row.input_tokens ?? 0) + (row.output_tokens ?? 0)
    const prevTotal = prev ? (prev.input_tokens ?? 0) + (prev.output_tokens ?? 0) : -1
    if (!prev || total > prevTotal) noModelByCycle.set(cycle, row)
  }
  return [...withModel, ...noModelByCycle.values()]
}

export function buildInferenceCostReport(
  projectId: string,
  window: CostWindowOptions
): InferenceCostReport {
  const rows = query<UsageRow>(
    projectId,
    `SELECT work_cycle_id, source, model_id, input_tokens, output_tokens
     FROM token_usage
     WHERE measured_at >= ?`,
    sinceMs(window.days)
  )
  const counted = selectRows(rows)

  const byModelMap = new Map<string, InferenceCostModelSlice>()
  const byProviderMap = new Map<ProviderId, InferenceCostSlice>()

  const emptyProvider = (provider: ProviderId): InferenceCostSlice => ({
    provider,
    providerLabel: providerLabel(provider),
    tokensIn: 0,
    tokensOut: 0,
    tokensTotal: 0,
    apiEquivalentUsd: 0,
    meteredUsd: 0,
    subsidizedUsd: 0,
    unpricedTokens: 0,
  })

  for (const row of counted) {
    const tokensIn = Number(row.input_tokens) || 0
    const tokensOut = Number(row.output_tokens) || 0
    const rate = row.model_id ? resolveModelRate(row.model_id) : null
    const provider: ProviderId = rate?.provider ?? providerFromSource(row.source ?? '')
    const priced = rate ? apiCostUsd(tokensIn, tokensOut, rate) : null
    const unpriced = priced === null ? tokensIn + tokensOut : 0
    const apiUsd = priced ?? 0
    const meteredUsd = 0
    const subsidizedUsd = apiUsd - meteredUsd

    const modelKey = row.model_id?.trim() || '(unattributed)'
    const existingModel = byModelMap.get(modelKey)
    if (existingModel) {
      existingModel.tokensIn += tokensIn
      existingModel.tokensOut += tokensOut
      if (priced !== null) {
        existingModel.apiEquivalentUsd = (existingModel.apiEquivalentUsd ?? 0) + priced
      }
    } else {
      byModelMap.set(modelKey, {
        model: modelKey,
        provider,
        providerLabel: providerLabel(provider),
        tokensIn,
        tokensOut,
        inputPerMillion: rate?.inputPerMillion ?? null,
        outputPerMillion: rate?.outputPerMillion ?? null,
        apiEquivalentUsd: priced,
      })
    }

    const bucket = byProviderMap.get(provider) ?? emptyProvider(provider)
    bucket.tokensIn += tokensIn
    bucket.tokensOut += tokensOut
    bucket.tokensTotal += tokensIn + tokensOut
    bucket.apiEquivalentUsd += apiUsd
    bucket.meteredUsd += meteredUsd
    bucket.subsidizedUsd += subsidizedUsd
    bucket.unpricedTokens += unpriced
    byProviderMap.set(provider, bucket)
  }

  const byProvider = [...byProviderMap.values()].sort(
    (a, b) => b.apiEquivalentUsd - a.apiEquivalentUsd || b.tokensTotal - a.tokensTotal
  )
  const byModel = [...byModelMap.values()].sort(
    (a, b) =>
      (b.apiEquivalentUsd ?? 0) - (a.apiEquivalentUsd ?? 0) ||
      b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut)
  )

  const tokensIn = byProvider.reduce((s, p) => s + p.tokensIn, 0)
  const tokensOut = byProvider.reduce((s, p) => s + p.tokensOut, 0)
  const apiEquivalentUsd = byProvider.reduce((s, p) => s + p.apiEquivalentUsd, 0)
  const meteredUsd = byProvider.reduce((s, p) => s + p.meteredUsd, 0)
  const subsidizedUsd = byProvider.reduce((s, p) => s + p.subsidizedUsd, 0)
  const unpricedTokens = byProvider.reduce((s, p) => s + p.unpricedTokens, 0)

  return {
    windowDays: window.days,
    windowLabel: windowLabel(window.days),
    generatedAt: new Date().toISOString(),
    tokensIn,
    tokensOut,
    tokensTotal: tokensIn + tokensOut,
    apiEquivalentUsd,
    meteredUsd,
    subsidizedUsd,
    unpricedTokens,
    byProvider,
    byModel,
  }
}

function modelsFor(report: InferenceCostReport, provider: ProviderId): InferenceCostModelSlice[] {
  return report.byModel.filter((m) => m.provider === provider)
}

function tokenCount(tokensIn: number, tokensOut: number): string {
  return `${(tokensIn + tokensOut).toLocaleString()} tokens`
}

function totalLine(amount: number, label = 'Total API cost', bold = true): string {
  const wrapped = bold ? `**${formatUsd(amount)}**` : formatUsd(amount)
  return `${label}: ${wrapped}`
}

export function formatInferenceCostMd(report: InferenceCostReport): string {
  const lines = ['# Cost simulation', '', `Window: ${report.windowLabel}`, '']
  if (report.byProvider.length === 0) {
    lines.push('No measured inference in this window.')
    return lines.join('\n')
  }

  for (const provider of report.byProvider) {
    const models = modelsFor(report, provider.provider)
    lines.push(`## ${provider.providerLabel}`, '')
    if (models.length === 0) {
      lines.push(tokenCount(provider.tokensIn, provider.tokensOut))
      lines.push(totalLine(provider.apiEquivalentUsd))
    } else {
      for (const model of models) {
        lines.push(`### ${model.model}`)
        lines.push(tokenCount(model.tokensIn, model.tokensOut))
        lines.push(totalLine(model.apiEquivalentUsd ?? 0))
        lines.push('')
      }
      if (models.length > 1) {
        lines.push(
          totalLine(provider.apiEquivalentUsd, `Total API cost · ${provider.providerLabel}`)
        )
      }
    }
    if (provider.unpricedTokens > 0) {
      lines.push(`${provider.unpricedTokens.toLocaleString()} tokens not priced (no model id).`)
    }
    lines.push('')
  }

  if (report.byProvider.length > 1) {
    lines.push(`## Total — ${report.byProvider.length} providers`, '')
    lines.push(tokenCount(report.tokensIn, report.tokensOut))
    lines.push(totalLine(report.apiEquivalentUsd))
    if (report.unpricedTokens > 0) {
      lines.push(`${report.unpricedTokens.toLocaleString()} tokens not priced.`)
    }
    lines.push('')
  }

  return lines.join('\n').trimEnd()
}

export function formatInferenceCostText(report: InferenceCostReport): string {
  const lines = [`cost simulation · ${report.windowLabel}`]
  if (report.byProvider.length === 0) {
    lines.push('No measured inference in this window.')
    return lines.join('\n')
  }
  for (const provider of report.byProvider) {
    const models = modelsFor(report, provider.provider)
    lines.push('')
    lines.push(provider.providerLabel)
    if (models.length === 0) {
      lines.push(`  ${tokenCount(provider.tokensIn, provider.tokensOut)}`)
      lines.push(`  ${totalLine(provider.apiEquivalentUsd, 'Total API cost', false)}`)
    } else {
      for (const model of models) {
        lines.push(`  ${model.model}`)
        lines.push(`    ${tokenCount(model.tokensIn, model.tokensOut)}`)
        lines.push(`    ${totalLine(model.apiEquivalentUsd ?? 0, 'Total API cost', false)}`)
      }
      if (models.length > 1) {
        lines.push(
          `  ${totalLine(provider.apiEquivalentUsd, `Total API cost · ${provider.providerLabel}`, false)}`
        )
      }
    }
  }
  if (report.byProvider.length > 1) {
    lines.push('')
    lines.push(`Total (${report.byProvider.length} providers)`)
    lines.push(`  ${tokenCount(report.tokensIn, report.tokensOut)}`)
    lines.push(`  ${totalLine(report.apiEquivalentUsd, 'Total API cost', false)}`)
  }
  return lines.join('\n')
}

export function inferenceCostSnapshotId(days: number | null): string {
  return days === null ? 'inference-cost-all' : `inference-cost-${days}d`
}

function toSnapshot(report: InferenceCostReport) {
  return {
    id: inferenceCostSnapshotId(report.windowDays),
    windowDays: report.windowDays,
    generatedAt: report.generatedAt,
    tokensIn: report.tokensIn,
    tokensOut: report.tokensOut,
    tokensTotal: report.tokensTotal,
    simulatedUsd: report.apiEquivalentUsd,
    models: report.byModel.map((m) => ({
      model: m.model,
      provider: m.provider,
      tokensIn: m.tokensIn,
      tokensOut: m.tokensOut,
      inputPerMillion: m.inputPerMillion,
      outputPerMillion: m.outputPerMillion,
      simulatedUsd: m.apiEquivalentUsd,
    })),
    providers: report.byProvider.map((p) => ({
      provider: p.provider,
      tokensIn: p.tokensIn,
      tokensOut: p.tokensOut,
      simulatedUsd: p.apiEquivalentUsd,
    })),
  }
}

/** Freeze this window's per-model rates + simulated cost (local event + sync upsert). */
export async function saveInferenceCostSnapshot(
  projectId: string,
  report: InferenceCostReport
): Promise<void> {
  const data = toSnapshot(report)
  try {
    prjctDb.appendEvent(projectId, 'metrics.inference_cost', data)
  } catch {
    /* snapshot must never block the report */
  }
  await publishCRUD({
    projectId,
    entityType: 'inference_cost_snapshots',
    entityId: data.id,
    eventType: 'upsert',
    data,
  })
}

export async function publishInferenceCostSnapshots(
  projectId: string,
  windows: Array<number | null> = [7, 30, 90]
): Promise<void> {
  await ensurePricingCatalog()
  for (const days of windows) {
    await saveInferenceCostSnapshot(projectId, buildInferenceCostReport(projectId, { days }))
  }
}
