/**
 * Alignment card — continuous mid-cycle "constitutional" checks.
 *
 * Anthropic's diagram productizes real-time alignment on every output.
 * prjct already has loop-guard, context-pressure, and quality orchestrator
 * at ship-time / prompt inject — this module UNIFIES the hard signals into
 * one named card agents learn as MUST, without owning the HOW.
 *
 * Soft advisories (goal discipline, token 80%, etc.) stay in prompt.ts;
 * this card only escalates when the harness must hard-steer.
 */

import type { ContextPressureVerdict } from './context-pressure'
import { SHIP_USER_ONLY } from './judgment-orchestrator'
import type { LoopGuardVerdict } from './loop-guard'

export type AlignmentLevel = 'ok' | 'warn' | 'hard'

export interface AlignmentCardInput {
  /** Hard stop when turn budget exceeded without --extend. */
  loop?: LoopGuardVerdict | null
  /** Context window pressure (turn/token proxy). */
  pressure?: ContextPressureVerdict | null
  /** Open quality ledger inject (may be multi-line markdown). */
  qualityInject?: string | null
  /**
   * Soft stuck threshold (default 15). When turns >= threshold and loop
   * is not already hard-stopped, emit warn-tier re-plan cue.
   */
  turns?: number
  stuckThreshold?: number
}

export interface AlignmentCard {
  level: AlignmentLevel
  /** Full inject block including header, or null when nothing to say. */
  markdown: string | null
  /** Short single-line cues (for statusline / tests). */
  cues: string[]
}

const DEFAULT_STUCK = 15

/**
 * Build a single mid-cycle alignment card from pure signals.
 * Priority: loop hard stop > pressure critical > quality ledger > stuck warn.
 */
export function buildAlignmentCard(input: AlignmentCardInput): AlignmentCard {
  const cues: string[] = []
  const blocks: string[] = []

  if (input.loop?.stopped && input.loop.message) {
    cues.push('loop-hard-stop')
    blocks.push(input.loop.message)
  }

  if (input.pressure?.level === 'critical' && input.pressure.cue) {
    cues.push('context-pressure-critical')
    // cue already has header; keep body lines
    blocks.push(input.pressure.cue)
  } else if (input.pressure?.level === 'warn' && input.pressure.cue) {
    // Warn is still mid-cycle hard-steer: compact path is mandatory at ≥60%.
    cues.push('context-pressure-warn')
    blocks.push(input.pressure.cue)
  }

  if (input.qualityInject?.trim()) {
    cues.push('quality-ledger')
    blocks.push(input.qualityInject.trim())
  }

  const turns = input.turns ?? 0
  const stuck = input.stuckThreshold ?? DEFAULT_STUCK
  if (!input.loop?.stopped && turns >= stuck) {
    cues.push('stuck-cycle')
    blocks.push(
      `⚠ ${turns} turns on this cycle and it is still open. If you are not nearly done, STOP looping: split it, ship the slice that works, or check in with the user — then \`prjct status done\`. A re-plan beats another grinding turn.`
    )
  }

  if (blocks.length === 0) {
    return { level: 'ok', markdown: null, cues: [] }
  }
  const hard = cues.some((cue) =>
    ['loop-hard-stop', 'context-pressure-critical', 'context-pressure-warn'].includes(cue)
  )
  const warn = cues.some((cue) => ['quality-ledger', 'stuck-cycle'].includes(cue))

  const level: AlignmentLevel = hard ? 'hard' : warn ? 'warn' : 'ok'
  // Every block already carries its own `# prjct:` header. Adding a wrapper
  // header on top renders an empty section — a heading with nothing under it,
  // on every turn. Only add one when the blocks bring no header of their own.
  const blocksSelfHeader = blocks.every((b) => b.trimStart().startsWith('# prjct:'))
  const header = blocksSelfHeader
    ? null
    : level === 'hard'
      ? '# prjct: alignment (MUST — hard gate)'
      : '# prjct: alignment (mid-cycle)'

  // Ship policy reminder only when quality is in play and not already quoted.
  const joined = blocks.join('\n\n')
  const shipNote =
    cues.includes('quality-ledger') && !joined.includes('prjct ship')
      ? `\n\n_${SHIP_USER_ONLY}_`
      : ''

  return {
    level,
    cues,
    markdown: header ? `${header}\n\n${joined}${shipNote}` : `${joined}${shipNote}`,
  }
}

/**
 * Compact one-liner for statusline / doctor when card is non-ok.
 */
export function alignmentCardSummary(card: AlignmentCard): string | null {
  if (card.level === 'ok' || card.cues.length === 0) return null
  return `alignment:${card.level} [${card.cues.join(',')}]`
}
