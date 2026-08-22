/**
 * Refuse to store a memory that contradicts one already believed.
 *
 * prjct deduplicates near-identical memories, so an exact restatement is
 * dropped. The dangerous case is the opposite one and had no check at all: a
 * new entry that says the SAME thing with the polarity flipped. Both survive,
 * both stay live, and whichever wins the L0 slot is served as authoritative —
 * so a corrected fact can be re-asserted in its old form and be believed.
 *
 * That happened: "prjct upgrade does NOT regenerate the Claude skill" was
 * corrected to "it does, as of v4.6.0", and the stale claim reappeared
 * afterwards as a new gotcha with a higher id and won the binding tip slot.
 *
 * `decisionConflictVerdict` does not cover this — it is an EDIT-time gate
 * ("Edit may contradict [decision] …") that fires when a FILE is touched.
 * Nothing compared a new memory against existing memories at WRITE time.
 *
 * Deliberately narrow: only near-duplicate content with opposite polarity
 * counts. A genuine refinement reads as a near-dup with the SAME polarity and
 * is untouched; unrelated content never reaches the polarity check.
 */

import type { MemoryEntry } from '../memory/entries'
import { computeExcess } from './retention/excess'

/**
 * Similarity at which two LEADING CLAIMS are about the same thing.
 *
 * Calibrated on the contradiction that actually occurred, not guessed:
 *
 *   0.79  "upgrade does NOT regenerate the skill" vs "upgrade regenerates it"
 *   0.81  same subject, same polarity (a refinement — excluded by polarity)
 *   0.67  related but a different subject (`sync` vs `upgrade`)
 *   0.36  negated but unrelated
 *   0.03  unrelated
 *
 * 0.75 separates the real case from the nearest non-contradiction. Comparing
 * whole bodies instead scores that same pair 0.69 — supporting detail dilutes
 * the claim — which is why only the leading claims are compared.
 */
export const CONTRADICTION_SIM = 0.75

/** Types trusted enough that contradicting one silently is a real problem. */
const HIGH_CONFIDENCE = new Set(['gotcha', 'anti-pattern', 'decision'])

/**
 * Negations that flip a claim. Matched as whole words so "cannot" and
 * "not" count while "another" and "note" do not.
 */
const NEGATION =
  /\b(?:not|never|no|none|cannot|can't|don't|doesn't|didn't|won't|isn't|aren't|wasn't|shouldn't|must not|no longer|stop|stopped|without)\b/gi

/** The leading claim — polarity elsewhere belongs to other clauses. */
function leadClaim(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  const end = collapsed.search(/[.;!?](\s|$)/)
  return end > 0 ? collapsed.slice(0, end) : collapsed
}

/** Whether the leading claim is negated. */
export function isNegated(text: string): boolean {
  NEGATION.lastIndex = 0
  return NEGATION.test(leadClaim(text))
}

/**
 * True when two statements assert the opposite of each other.
 *
 * Presence on the LEADING claim, not a count over the whole text. Counting
 * misses the real case: "does NOT regenerate … never called from upgrade"
 * carries two negations, and "regenerates …" carries none — same parity,
 * opposite meaning. The trailing "never …" reinforces the first clause rather
 * than flipping it, so only the claim itself may vote.
 */
export function polarityDiffers(a: string, b: string): boolean {
  return isNegated(a) !== isNegated(b)
}

export interface MemoryContradiction {
  /** The believed entry the new content would contradict. */
  id: string
  type: string
  content: string
  similarity: number
  /** Ready-to-print refusal naming the entry and both ways forward. */
  message: string
}

/**
 * Find a live, high-confidence memory the new content contradicts.
 *
 * Returns null when nothing conflicts — the overwhelmingly common case, so the
 * similarity scan runs only over high-confidence entries.
 */
export function findContradiction(
  content: string,
  type: string,
  existing: MemoryEntry[]
): MemoryContradiction | null {
  const claim = content.trim()
  if (claim.length < 24) return null

  const claimLead = leadClaim(claim)
  const claimNegated = isNegated(claim)

  // Filter by polarity BEFORE scoring similarity.
  //
  // `computeExcess` reports only the single nearest entry, so scoring the whole
  // set first lets a closer but COMPATIBLE neighbour mask a real contradiction —
  // including a copy of the very claim being stored. Restricting the reference
  // set to opposite-polarity entries makes the nearest of that set the answer
  // we actually want, and costs one cheap regex per candidate.
  const believed = existing.filter(
    (e) =>
      HIGH_CONFIDENCE.has(e.type) &&
      typeof e.content === 'string' &&
      e.content.trim() &&
      isNegated(e.content) !== claimNegated
  )
  if (believed.length === 0) return null

  // Compare claims, not bodies: a contradiction is about what is asserted,
  // and the supporting detail around it only dilutes the signal.
  const claimsOnly = believed.map((e) => ({ ...e, content: leadClaim(e.content ?? '') }))
  const { maxSim, nearestId } = computeExcess(claimLead, claimsOnly)
  if (maxSim < CONTRADICTION_SIM || !nearestId) return null

  const nearest = believed.find((e) => e.id === nearestId)
  if (!nearest?.content) return null

  const preview = nearest.content.replace(/\s+/g, ' ').slice(0, 110)
  return {
    id: nearest.id,
    type: nearest.type,
    content: nearest.content,
    similarity: maxSim,
    message: [
      `prjct: refused — this contradicts a memory already in force.`,
      ``,
      `  Believed  [${nearest.type} ${nearest.id}] ${preview}`,
      `  Storing   [${type}] ${claim.replace(/\s+/g, ' ').slice(0, 110)}`,
      ``,
      `Both cannot be true. Storing this would leave two live entries disagreeing,`,
      `and whichever reaches L0 first is served as authoritative.`,
      ``,
      `If the new statement is right, supersede the old one explicitly:`,
      `  prjct remember ${type} "<content>" --tags supersedes:${nearest.id}`,
      `If the old one is right, nothing needs storing.`,
    ].join('\n'),
  }
}

/**
 * An explicit `supersedes:<id>` tag is the author saying "I know, replace it" —
 * the escape hatch that keeps the gate from blocking a real correction.
 */
export function supersedesId(tags: Record<string, string> | undefined): string | null {
  const raw = tags?.supersedes?.trim()
  return raw ? raw : null
}
