/**
 * Contradictory-review consent gate — the first step of every `prjct ship`.
 *
 * Contradictory review (audit's *procédure contradictoire*, adversarial review
 * in agent work) closes no finding without letting the other side rebut it.
 * `prjct judgment` already IS that machine; what was missing is consent —
 * intensity came from diff size or the `code-strict` pack, so on a default
 * project the gate was a soft reminder five gates deep.
 *
 * Pure decision; all I/O stays in the caller, like `judgmentShipVerdict`.
 *
 * Invariant: the question returns on every ship until the ledger is `approved`
 * AND still bound to the tree being shipped. A decline is evidence, never a
 * bypass — it is absent from the inputs so a stored one CANNOT suppress the
 * next ask.
 */

import type { JudgmentVerdict, ReviewIntensity } from '../schemas/judgment'
import type { CommandClarification } from '../types/commands'

/** What the user can answer. `full` is the contradictory (dual-blind) one. */
export type ContradictoryChoice = 'full' | 'standard' | 'skip'

/** Intensity a chosen review runs at — `skip` is a decline, not a review. */
export type ContradictoryIntensity = Exclude<ReviewIntensity, 'skip'>

/** Ship intents that answer the gate, in the order the question offers them. */
export const CONTRADICTORY_OPTIONS: readonly string[] = [
  'review-full',
  'review-standard',
  'review-skip',
  'abort',
]

/** `--intent=review-*` → the answer it carries. Unknown intents answer nothing. */
export function choiceFromIntent(intent: string | null | undefined): ContradictoryChoice | null {
  if (intent === 'review-full') return 'full'
  if (intent === 'review-standard') return 'standard'
  if (intent === 'review-skip') return 'skip'
  return null
}

export interface ContradictoryGateInput {
  /** Answer carried by THIS invocation (`--intent=review-*`), if any. */
  choice: ContradictoryChoice | null
  /** `computeVerdict(ledger)` — null when no ledger exists. */
  ledgerVerdict: JudgmentVerdict | null
  /** Ledger id for the question text (truncated for display). */
  ledgerId?: string | null
  /** Intensity the open ledger runs at. */
  ledgerIntensity?: ReviewIntensity | null
  /** Approved ledger still content-bound to the tree being shipped. */
  stampValid: boolean
  /** Something to review — an empty diff has nothing to contradict. */
  hasChangeset: boolean
  /** `--intent=register-only` records a row; it ships no code. */
  registerOnly: boolean
}

export type ContradictoryGateReason =
  | 'register-only'
  | 'empty-changeset'
  | 'declined'
  | 'chosen'
  | 'approved'
  | 'stamp-drift'
  | 'unfinished-ledger'
  | 'no-ledger'

export type ContradictoryGateVerdict =
  | {
      kind: 'proceed'
      reason: ContradictoryGateReason
      /**
       * True once a contradictory review approved this exact tree. The
       * downstream judgment gate then hard-blocks even off `code-strict` —
       * without it the question would be decorative on a default project.
       */
      binding: boolean
      message: string
    }
  | { kind: 'ask'; reason: ContradictoryGateReason; clarification: CommandClarification }
  | {
      kind: 'open-review'
      reason: ContradictoryGateReason
      intensity: ContradictoryIntensity
      message: string
    }

const HEADLINE =
  'Contradictory review before ship? RED (attack) + BLUE (defense) judge this changeset blind — ship stays blocked until they agree.'

function ask(
  reason: ContradictoryGateReason,
  question: string,
  state: Record<string, unknown>
): ContradictoryGateVerdict {
  return {
    kind: 'ask',
    reason,
    clarification: { question, options: [...CONTRADICTORY_OPTIONS], state },
  }
}

function whyUnfinished(verdict: JudgmentVerdict): string {
  if (verdict === 'escalated') return 'the judges contradict each other and nobody resolved it'
  if (verdict === 'blocked') return 'findings survived refutation and are still open'
  return 'the reviewers have not reported yet'
}

/**
 * Decide the first step of ship. Ordering is load-bearing: an explicit answer
 * on this invocation outranks stored state, and an approved ledger still bound
 * to the tree is the ONLY way past the question.
 */
export function contradictoryReviewGate(input: ContradictoryGateInput): ContradictoryGateVerdict {
  // A register-only ship writes a shipped row; there is no diff to attack.
  if (input.registerOnly) {
    return { kind: 'proceed', reason: 'register-only', binding: false, message: '' }
  }

  if (!input.hasChangeset) {
    return { kind: 'proceed', reason: 'empty-changeset', binding: false, message: '' }
  }

  if (input.choice === 'skip') {
    return {
      kind: 'proceed',
      reason: 'declined',
      binding: false,
      message:
        '⚖️  Contradictory review DECLINED for this changeset — recorded as an override. ' +
        'The next ship asks again.',
    }
  }

  if (input.choice === 'full' || input.choice === 'standard') {
    return {
      kind: 'open-review',
      reason: 'chosen',
      intensity: input.choice,
      message:
        input.choice === 'full'
          ? '⚖️  Contradictory review (dual-blind RED + BLUE) — run the card below, then re-run ship.'
          : '⚖️  Standard review (single reviewer + evidence tax) — run the card below, then re-run ship.',
    }
  }

  const shortId = input.ledgerId ? input.ledgerId.slice(0, 8) : null
  const idBit = shortId ? ` ${shortId}` : ''

  if (input.ledgerVerdict === 'approved') {
    if (input.stampValid) {
      return {
        kind: 'proceed',
        reason: 'approved',
        binding: true,
        message: `⚖️  Contradictory review${idBit} APPROVED and still bound to this tree — the judges agree.`,
      }
    }
    // Approved, then the code moved. The agreement no longer covers what ships.
    return ask(
      'stamp-drift',
      `The approved review${idBit} no longer matches the tree being shipped — the code changed after the judges agreed. Review again?`,
      { ledgerId: shortId, verdict: 'approved', contentBound: 'drift' }
    )
  }

  if (input.ledgerVerdict !== null) {
    return ask(
      'unfinished-ledger',
      `Review${idBit} is ${input.ledgerVerdict} — ${whyUnfinished(input.ledgerVerdict)}. Continue the contradictory review (\`prjct judgment next\`) before ship?`,
      {
        ledgerId: shortId,
        verdict: input.ledgerVerdict,
        intensity: input.ledgerIntensity ?? null,
      }
    )
  }

  return ask('no-ledger', HEADLINE, { ledger: null })
}
