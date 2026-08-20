/**
 * Quality orchestrator (P0) — automatic judgment when required; ship only after
 * explicit user text confirmation.
 *
 * Doctrine:
 *  - Human asks for features only. Quality opens/injects itself when intensity
 *    is standard|full (or harness forces full).
 *  - Agents MAY suggest ship when quality is ready, but MUST wait for an
 *    explicit text confirmation this turn (e.g. "ship", "sí, publícalo") before
 *    running `prjct ship`. Never ship on silence, Stop, or green tests alone.
 *  - This module never calls ship.
 *  - Pure CLI steps only (open ledger, next card text). Host agent runs
 *    RED/BLUE / challenge following the card.
 */

import type { JudgmentLedger, ReviewIntensity } from '../schemas/judgment'
import { judgmentLedgerStorage } from '../storage/judgment-ledger-storage'
import { getTimestamp } from '../utils/date-helper'
import { computeCommittedChangeset, computeWorkingTreeChangeset } from './delivery-geometry'
import {
  buildNextAction,
  createLedger,
  type IntensitySignals,
  intensityFromChangeset,
  type NextActionCard,
} from './precision-judgment'
import { resolvePrivateSkillPath } from './private-skill-router'

/**
 * Ship policy: suggest OK, execute only after explicit user text this turn.
 * Shared by skill + orchestration + inject.
 */
export const SHIP_USER_ONLY =
  'Ship: you MAY suggest when ready, but run `prjct ship` ONLY after the user confirms in text this turn (e.g. "ship", "sí publícalo"). Never ship on silence, Stop, or green tests alone.'

export type QualityCeremony = 'none' | 'standard' | 'full'

export function qualityFromIntensity(intensity: ReviewIntensity): QualityCeremony {
  if (intensity === 'skip') return 'none'
  if (intensity === 'standard') return 'standard'
  return 'full'
}

export function intensityFromQuality(q: QualityCeremony): ReviewIntensity {
  if (q === 'none') return 'skip'
  if (q === 'standard') return 'standard'
  return 'full'
}

export interface EnsureLedgerResult {
  /** Whether a new ledger was created. */
  opened: boolean
  intensity: ReviewIntensity
  quality: QualityCeremony
  ledger: JudgmentLedger | null
  next: NextActionCard
}

/**
 * Resolve intensity from git changeset + harness signals (working tree preferred
 * mid-cycle; committed range for ship-like views).
 */
export async function resolveWorkIntensity(
  projectPath: string,
  signals: IntensitySignals = {}
): Promise<{ intensity: ReviewIntensity; files: number; loc: number }> {
  const { files, loc } = await (async () => {
    try {
      const wt = await computeWorkingTreeChangeset(projectPath)
      if (wt && (wt.files > 0 || wt.loc > 0)) return { files: wt.files, loc: wt.loc }
      const committed = await computeCommittedChangeset(projectPath)
      return { files: committed?.files ?? 0, loc: committed?.loc ?? 0 }
    } catch {
      return { files: 0, loc: 0 }
    }
  })()
  const { intensity } = intensityFromChangeset({ files, loc }, signals)
  return { intensity, files, loc }
}

/**
 * Ensure an active judgment ledger exists when quality is required.
 * Idempotent: reuses in_progress / approved ledger; never opens on skip.
 * Does NOT run ship.
 */
export async function ensureJudgmentLedger(input: {
  projectId: string
  projectPath: string
  target?: string
  signals?: IntensitySignals
  /** Force intensity (e.g. from orchestration quality field). */
  forceIntensity?: ReviewIntensity
}): Promise<EnsureLedgerResult> {
  const resolved = await resolveWorkIntensity(input.projectPath, input.signals ?? {})
  const intensity = input.forceIntensity ?? resolved.intensity
  const quality = qualityFromIntensity(intensity)

  const existing = judgmentLedgerStorage.get(input.projectId)
  if (quality === 'none') {
    const next = buildNextAction(existing, intensity)
    return { opened: false, intensity, quality, ledger: existing, next }
  }

  if (existing && (existing.verdict === 'in_progress' || existing.verdict === 'approved')) {
    const next = buildNextAction(existing, existing.intensity)
    return { opened: false, intensity: existing.intensity, quality, ledger: existing, next }
  }

  const target =
    input.target?.trim() ||
    (await defaultBranchTarget(input.projectPath)) ||
    `work-${getTimestamp().slice(0, 10)}`

  const deliveryTier: 'trivial' | 'normal' | 'large' | undefined = await import(
    './delivery-geometry'
  )
    .then(({ tierOf }) => tierOf({ files: resolved.files, loc: resolved.loc }))
    .catch(() => undefined)

  const scopePaths = await (async () => {
    try {
      const { computeCommittedChangeset } = await import('./delivery-geometry')
      const cs = await computeCommittedChangeset(input.projectPath)
      if (cs?.base) {
        const { execFileAsync } = await import('../utils/exec')
        const { stdout } = await execFileAsync('git', ['diff', '--name-only', `${cs.base}..HEAD`], {
          cwd: input.projectPath,
        })
        return stdout
          .split('\n')
          .map((path) => path.trim())
          .filter(Boolean)
      }
      return cs?.dirs?.length ? [...cs.dirs] : undefined
    } catch {
      return undefined
    }
  })()

  const ledger = createLedger({
    target,
    intensity,
    deliveryTier,
    now: getTimestamp(),
    scopePaths,
  })
  judgmentLedgerStorage.set(input.projectId, ledger)
  const next = buildNextAction(ledger, intensity)
  return { opened: true, intensity, quality, ledger, next }
}

/**
 * Markdown block for prompt/stop inject. May suggest ship when approved;
 * never auto-runs ship. Returns null when no quality work is pending.
 */
export function formatQualityInject(
  card: NextActionCard,
  ledger: JudgmentLedger | null
): string | null {
  if (card.intensity === 'skip') return null
  if (ledger?.verdict === 'approved') {
    return [
      '# prjct: quality ready',
      '',
      `- Judgment ledger \`${ledger.id.slice(0, 8)}\` → **APPROVED** (intensity=${ledger.intensity}).`,
      '- You MAY suggest: work is ready to ship when they want.',
      `- ${SHIP_USER_ONLY}`,
    ].join('\n')
  }

  if (card.kind === 'skip_ship') return null

  const lines = [
    '# prjct: quality orchestrator (automatic)',
    '',
    `- **kind**: \`${card.kind}\` · intensity **${card.intensity}** · round ${card.fixRound}/${card.maxFixRounds}`,
    `- **directive**: ${card.directive}`,
    '',
    '### Steps (run these — human does not type judgment)',
    ...card.steps.map((s, i) => `${i + 1}. ${s}`),
    '',
    `_${SHIP_USER_ONLY}_`,
  ]
  if (card.judgeCharters) {
    lines.push(
      '',
      '### Charters',
      `RED: ${card.judgeCharters.red}`,
      '',
      `BLUE: ${card.judgeCharters.blue}`
    )
  }
  lines.push(...reviewDispatchGuidance(card))
  if (card.rankedFixIds.length) {
    lines.push('', `### Blast rank: ${card.rankedFixIds.join(' → ')}`)
  }
  return lines.join('\n')
}

/** Private methodology is exposed only while reviewers are being dispatched. */
export function reviewDispatchGuidance(card: NextActionCard): string[] {
  if (card.kind !== 'dispatch_reviewers') return []
  const workflow = (() => {
    try {
      return resolvePrivateSkillPath('code-review.md')
    } catch {
      // Source/dev installs may be incomplete; the quality loop remains usable.
      return null
    }
  })()
  return [
    '',
    '### Review methodology (auto; read on demand)',
    workflow ? `workflow:code-review=\`${workflow}\`` : '',
    '- Keep Standards findings and Spec/acceptance findings independent; do not let one substitute for the other.',
    '- Standards includes comment discipline: keep comments for intent, invariants, constraints, and non-obvious tradeoffs—not narration of visible code.',
  ].filter(Boolean)
}

/**
 * Build inject text for the current project (prompt/stop). Pure read + format.
 * Opens nothing — call ensureJudgmentLedger on work start.
 */
export function qualityInjectForProject(projectId: string): string | null {
  const ledger = judgmentLedgerStorage.get(projectId)
  const intensity = ledger?.intensity ?? 'skip'
  if (!ledger && intensity === 'skip') return null
  const card = buildNextAction(
    ledger,
    intensity === 'skip' && ledger ? ledger.intensity : intensity
  )
  // If no ledger and we don't know intensity, skip inject (work start will open)
  if (!ledger) {
    // Still inject if somehow quality was required but ledger missing mid-cycle
    return null
  }
  return formatQualityInject(card, ledger)
}

async function defaultBranchTarget(projectPath: string): Promise<string | null> {
  try {
    const { getGitBranch } = await import('../session/git-helpers')
    return (await getGitBranch(projectPath)) ?? null
  } catch {
    return null
  }
}

/** Test helper: hard-require quality for ship when intensity is not skip. */
export function shipRequiresQuality(intensity: ReviewIntensity): boolean {
  return intensity !== 'skip'
}
