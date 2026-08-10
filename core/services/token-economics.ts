/**
 * Token economics as a product score — daily/cycle spend vs budget.
 * Surfaced on prime + harness (existing verbs only).
 */

import { prjctDb } from '../storage/database'

export interface TokenEconomics {
  /** Tokens attributed to tasks updated in the last 24h (in+out). */
  tokens24h: number
  /** Tokens on the active cycle if any. */
  cycleTokens: number
  cycleBudget: number | null
  /** 0–100 health: under budget / low spend = higher. */
  score: number
  line: string
}

export function buildTokenEconomics(
  projectId: string,
  opts: {
    cycleTokensIn?: number
    cycleTokensOut?: number
    maxTokensPerCycle?: number | null
  } = {}
): TokenEconomics {
  const since = Date.now() - 24 * 60 * 60 * 1000
  const tokens24h = (() => {
    try {
      return prjctDb
        .query<{ tin: number | null; tout: number | null }>(
          projectId,
          `SELECT tokens_in AS tin, tokens_out AS tout FROM tasks
           WHERE updated_at IS NOT NULL AND updated_at >= ?
           LIMIT 200`,
          new Date(since).toISOString()
        )
        .reduce((total, row) => total + (row.tin ?? 0) + (row.tout ?? 0), 0)
    } catch {
      return (
        prjctDb.get<{ s: number }>(
          projectId,
          `SELECT COALESCE(SUM(COALESCE(tokens_in,0)+COALESCE(tokens_out,0)),0) AS s FROM tasks`
        )?.s ?? 0
      )
    }
  })()

  const cycleTokens = (opts.cycleTokensIn ?? 0) + (opts.cycleTokensOut ?? 0)
  const cycleBudget = opts.maxTokensPerCycle ?? null

  // Score: reward measured low thrash; penalize over-budget cycles.
  const score = (() => {
    if (tokens24h === 0 && cycleTokens === 0) return 80
    if (cycleBudget && cycleBudget > 0) {
      const ratio = cycleTokens / cycleBudget
      if (ratio <= 0.5) return 100
      if (ratio <= 0.8) return 85
      if (ratio <= 1.0) return 70
      if (ratio <= 1.2) return 45
      return 25
    }
    if (tokens24h < 50_000) return 90
    if (tokens24h < 200_000) return 75
    if (tokens24h < 500_000) return 55
    return 35
  })()

  const budgetBit =
    cycleBudget != null && cycleBudget > 0
      ? `cycle=${cycleTokens}/${cycleBudget}`
      : cycleTokens > 0
        ? `cycle=${cycleTokens}`
        : 'cycle=—'
  const line = `Token economics: 24h≈${tokens24h} · ${budgetBit} · score=${score}/100 (compound judgment > fresh-window thrash)`

  return { tokens24h, cycleTokens, cycleBudget, score, line }
}
