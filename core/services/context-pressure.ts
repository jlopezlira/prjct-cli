/**
 * Context-pressure cues — a report of MEASURED token spend, nothing else.
 *
 * This used to derive "context density" from `turns / maxTurnsPerCycle`
 * (default 15). A turn count is not context: on turn 9 of a cycle it announced
 * `context density (~60%)` and told the model to stop searching the codebase —
 * "no broad Grep/Glob thrash", "do not re-index the tree", "high-signal tools
 * only" — while the real window might be 3% full. That is a false fact about
 * the model's own state, used to cap how much work it does.
 *
 * Now the ratio comes only from tokens actually spent against a budget the
 * project explicitly configured (`maxTokensPerCycle`). With no budget there is
 * nothing measured, so there is no cue. The cue reports the number and names
 * the cheaper tools that exist; it never forbids reading code. "This cycle is
 * long" is a separate, honest signal already carried by the loop guard.
 */

import type { LocalConfig } from '../types/config'

const WARN_RATIO = 0.6
const CRITICAL_RATIO = 0.8

export type ContextPressureLevel = 'ok' | 'warn' | 'critical'

/** Minimal task shape — full CurrentTask or a slim ActiveTaskView projection. */
export interface ContextPressureTask {
  turnCount?: number
  tokensIn?: number
  tokensOut?: number
  description?: string
}

export interface ContextPressureVerdict {
  level: ContextPressureLevel
  /** Short hook line; null when nothing to say. */
  cue: string | null
  turns: number
  limit: number
  ratio: number
}

/**
 * Report token spend against an explicitly configured `maxTokensPerCycle`.
 * No budget configured → nothing is measured → no cue. Turn count is reported
 * for callers but never drives the level.
 */
export function contextPressureVerdict(
  config: LocalConfig | null | undefined,
  task: ContextPressureTask | null | undefined
): ContextPressureVerdict {
  const turns = task?.turnCount ?? 0
  const limit = config?.maxTokensPerCycle ?? 0
  const spent = (task?.tokensIn ?? 0) + (task?.tokensOut ?? 0)
  const ratio = limit > 0 ? spent / limit : 0

  if (!task || limit <= 0 || spent <= 0) {
    return { level: 'ok', cue: null, turns, limit, ratio: 0 }
  }

  const pct = Math.round(ratio * 100)
  const spentK = Math.round(spent / 1000)
  const limitK = Math.round(limit / 1000)

  // State the measurement and name the cheaper tools. Never forbid reading
  // code — the model decides what it needs to see to do the work correctly.
  if (ratio >= CRITICAL_RATIO) {
    return {
      level: 'critical',
      turns,
      limit,
      ratio,
      cue: `# prjct: token budget (${pct}% — ${spentK}k of ${limitK}k this cycle)
This is the budget YOU configured for a cycle, not the host context window — the host shows that separately, and the session continues either way.
Cheaper routes when they answer the same question: \`prjct context memory mem_N\` (pull by id), \`prjct code trace <symbol>\`, \`prjct search\`.
Read whatever the work actually requires; a wrong answer costs more than the tokens saved.`,
    }
  }

  if (ratio >= WARN_RATIO) {
    return {
      level: 'warn',
      turns,
      limit,
      ratio,
      cue: `# prjct: token budget (${pct}% — ${spentK}k of ${limitK}k this cycle)
Informational. Cheaper routes when they answer the same question: \`prjct context memory mem_N\`, \`prjct code trace <symbol>\`, \`prjct search\`. Not a reason to stop reading code.`,
    }
  }

  return { level: 'ok', cue: null, turns, limit, ratio }
}

/**
 * Ship hard-block. Default OFF — long sessions are valid.
 * Opt-in per project: config.contextPressure.hardBlockShip === true AND critical.
 */
export function contextPressureBlocksExpansion(
  v: ContextPressureVerdict,
  config?: LocalConfig | null
): boolean {
  if (config?.contextPressure?.hardBlockShip === true && v.level === 'critical') {
    return true
  }
  return false
}

/**
 * Host-agnostic one-liner for statusline / doctor.
 * Empty string when ok (no noise on the chrome).
 */
export function contextPressureStatusLine(v: ContextPressureVerdict): string {
  // "ctx:" read as the host context window; this is the cycle token budget.
  if (v.level === 'critical' || v.level === 'warn') {
    return `budget:${Math.round(v.ratio * 100)}% of cycle tokens`
  }
  return ''
}

/**
 * True once measured spend crosses the configured budget threshold. A hint to
 * prefer pull-by-id recall where it answers the same question — never a gate
 * on reading code.
 */
export function contextPressureRequiresCompactPath(v: ContextPressureVerdict): boolean {
  return v.level === 'warn' || v.level === 'critical'
}
