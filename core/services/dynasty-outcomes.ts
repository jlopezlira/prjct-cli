/**
 * Dynasty outcome rows for `prjct harness score` — closed-loop + retention + tokens.
 * Project-scoped (needs DB). Structural Δ stays in weak-frontier-demo (pure).
 */

import { prjctDb } from '../storage/database'
import { buildClosedLoopHealth, type ClosedLoopHealth } from './closed-loop-health'
import { type VaultHealth, vaultHealth } from './retention/purge'
import { buildTokenEconomics, type TokenEconomics } from './token-economics'
import { dominantModelForTask } from './work-cost-service'

export interface DynastyOutcomes {
  closedLoop: ClosedLoopHealth
  vault: VaultHealth
  tokens: TokenEconomics
  /** Lifetime tokens saved via sync compression (metrics_daily). */
  tokensSavedTotal: number
  /** Soft-deleted + archives as share of (live + soft + archives) — cleanup signal. */
  hygieneRatio: number
  line: string
  rows: Array<{ name: string; measured: string; note: string }>
}

function sumTokensSaved(projectId: string): number {
  try {
    const row = prjctDb.get<{ tokens: number }>(
      projectId,
      'SELECT COALESCE(SUM(tokens_saved), 0) AS tokens FROM metrics_daily'
    )
    return row?.tokens ?? 0
  } catch {
    return 0
  }
}

/**
 * Outcome health for Dynasty scorecard — receipts, vault hygiene, token economics.
 * Best-effort; never throws (caller wraps).
 */
export function buildDynastyOutcomes(projectId: string): DynastyOutcomes {
  const closedLoop = buildClosedLoopHealth(projectId)
  const vault = vaultHealth(projectId)
  const tokens = buildTokenEconomics(projectId, activeCycleUsage(projectId))
  const tokensSavedTotal = sumTokensSaved(projectId)

  const mass = vault.live + vault.softDeleted + vault.archives
  const hygieneRatio =
    mass > 0 ? Math.round(((vault.softDeleted + vault.archives) / mass) * 1000) / 10 : 0

  const rows: DynastyOutcomes['rows'] = [
    {
      name: 'Judgment receipts (7d)',
      measured: String(closedLoop.receipts7d),
      note: 'land/Stop closed-loop stamps',
    },
    {
      name: 'Conflict warn/deny (7d)',
      measured: `${closedLoop.conflictWarns7d}/${closedLoop.conflictDenies7d}`,
      note: 'decision-conflict gate activity',
    },
    {
      name: 'Preventive memories (7d)',
      measured: String(closedLoop.preventiveSurfaces7d),
      note: 'gotcha · anti-pattern · decision',
    },
    {
      name: 'Vault live / soft / archive',
      measured: `${vault.live} / ${vault.softDeleted} / ${vault.archives}`,
      note: `hygiene mass ${hygieneRatio}% (Rho not grow-forever)`,
    },
    {
      name: 'Auto-source live',
      measured: String(vault.autoSourceLive),
      note: 'session noise capped by retention',
    },
    {
      name: 'Tokens saved (lifetime sync)',
      measured: String(tokensSavedTotal),
      note: 'metrics_daily compression',
    },
    {
      name: 'Token economics (24h)',
      measured:
        tokens.score === null
          ? `≈${tokens.tokens24h} · no cycle budget set`
          : `≈${tokens.tokens24h} · budget adherence ${tokens.score}/100`,
      note: 'measurement, not a quality grade — fewer tokens is not a better outcome',
    },
  ]

  const line = `Dynasty outcomes: receipts7d=${closedLoop.receipts7d} · vault live=${vault.live} soft=${vault.softDeleted} · tokensSaved=${tokensSavedTotal} · tok24h≈${tokens.tokens24h}`

  return {
    closedLoop,
    vault,
    tokens,
    tokensSavedTotal,
    hygieneRatio,
    line,
    rows,
  }
}

export function renderDynastyOutcomesMd(outcomes: DynastyOutcomes): string {
  const body = outcomes.rows.map((r) => `| ${r.name} | ${r.measured} | ${r.note} |`)
  return [
    '## Dynasty outcomes (project)',
    '',
    'Compounding proof — not structural grade. Needs a live project DB.',
    '',
    '| Signal | Measured | Note |',
    '|---|---|---|',
    ...body,
    '',
    `**${outcomes.line}**`,
    '',
  ].join('\n')
}

/**
 * Spend and model for the newest cycle, so the budget can be derived rather
 * than demanded from config.
 *
 * `tasks` carries no token columns and no `updated_at` — spend lives in
 * `token_usage`, keyed by `work_cycle_id`. Best-effort: any failure reports no
 * budget rather than a wrong one.
 */
function activeCycleUsage(projectId: string): {
  cycleTokensIn?: number
  cycleTokensOut?: number
  model?: string | null
} {
  try {
    const task = prjctDb.get<{ id: string }>(
      projectId,
      'SELECT id FROM tasks ORDER BY started_at DESC LIMIT 1'
    )
    if (!task?.id) return {}
    const spend = prjctDb.get<{ tin: number | null; tout: number | null }>(
      projectId,
      `SELECT SUM(COALESCE(input_tokens,0)) AS tin, SUM(COALESCE(output_tokens,0)) AS tout
       FROM token_usage WHERE work_cycle_id = ?`,
      task.id
    )
    return {
      cycleTokensIn: spend?.tin ?? 0,
      cycleTokensOut: spend?.tout ?? 0,
      model: dominantModelForTask(projectId, task.id),
    }
  } catch {
    return {}
  }
}
