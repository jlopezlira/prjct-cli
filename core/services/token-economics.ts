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
  /**
   * 0–100 adherence to a configured cycle budget, or null when the project set
   * none. Never a proxy for quality: spending fewer tokens is not a better
   * outcome, it is just less work.
   */
  score: number | null
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

  // Budget adherence — ONLY meaningful against a budget the project set.
  //
  // This used to score raw spend: under 50k tokens scored 90, over 500k scored
  // 35. That is a "did you do less work" meter wearing a quality label — a day
  // that shipped nothing outscored a day that shipped three PRs, and the only
  // way to reach 100 was to stop working. With no budget configured there is
  // nothing to adhere to, so there is no score to report.
  const score = (() => {
    if (!cycleBudget || cycleBudget <= 0) return null
    const ratio = cycleTokens / cycleBudget
    if (ratio <= 0.8) return 100
    if (ratio <= 1.0) return 85
    if (ratio <= 1.2) return 60
    return 40
  })()

  const budgetBit =
    cycleBudget != null && cycleBudget > 0
      ? `cycle=${cycleTokens}/${cycleBudget}`
      : cycleTokens > 0
        ? `cycle=${cycleTokens}`
        : 'cycle=—'
  const line =
    score === null
      ? `Token economics: 24h≈${tokens24h} · ${budgetBit} · no cycle budget set (measurement only)`
      : `Token economics: 24h≈${tokens24h} · ${budgetBit} · budget adherence=${score}/100`

  return { tokens24h, cycleTokens, cycleBudget, score, line }
}
