/**
 * Excess information vs reference model R — the Rho core for project memory.
 *
 * Rho: excess_loss(token) = loss_train - loss_reference
 *   → keep tokens the reference does not already "know"
 *
 * prjct: excess(entry) = 1 - max_similarity(entry, R \ {entry})
 *   → high excess = novel contribution to the project model
 *   → low excess  = redundant with R (derivable / already stored)
 *
 * Implementation is pure + deterministic + 0 tokens:
 *   1. Exact content fingerprint match against R → excess = 0
 *   2. Local subword embedding cosine vs every R vector → max sim
 *   3. excess = clamp(1 - maxSim, 0, 1)
 *
 * Efficiency: vectors for R are computed once (O(|R|·L)); each candidate is
 * one embed + |R| cosines of dim 256. For |R|≤150 and n≤2k this is fine on
 * the sync path (single-digit ms on typical machines).
 */

import { memoryFingerprint } from '../../memory/content-fingerprint'
import type { MemoryEntry } from '../../memory/entries'
import { cosineSimilarity, embedLocalText } from '../embeddings'

/** Near-duplicate threshold: sim ≥ this ⇒ excess treated as ~0. */
export const NEAR_DUP_SIM = 0.92

/** Capture gate: below this excess, low-stakes types are rejected as redundant. */
export const CAPTURE_MIN_EXCESS = 0.18

export interface ExcessResult {
  /** 0 = fully known by R, 1 = totally novel. */
  excess: number
  /** Max cosine similarity to any reference member (0 if R empty). */
  maxSim: number
  /** Reference entry id that matched best (if any). */
  nearestId: string | null
  /** Exact fingerprint collision with R. */
  exactDup: boolean
  /** Near-dup by embedding (maxSim ≥ NEAR_DUP_SIM). */
  nearDup: boolean
}

export interface ReferenceIndex {
  entries: MemoryEntry[]
  fingerprints: Map<string, string> // fingerprint → entry id
  /** L2-normalized local vectors, parallel to entries. */
  vectors: Float64Array[]
}

/**
 * Precompute fingerprints + local vectors for R. Call once per evaluate.
 */
export function buildReferenceIndex(reference: MemoryEntry[]): ReferenceIndex {
  const fingerprints = new Map<string, string>()
  const vectors: Float64Array[] = []
  for (const e of reference) {
    fingerprints.set(memoryFingerprint(e.content), e.id)
    const v = embedLocalText(e.content)
    vectors.push(Float64Array.from(v))
  }
  return { entries: reference, fingerprints, vectors }
}

/**
 * Excess of `content` (and optional id) vs a prebuilt reference index.
 * Pass `excludeId` when the candidate is already in R.
 */
export function excessAgainstIndex(
  content: string,
  index: ReferenceIndex | null | undefined,
  excludeId?: string
): ExcessResult {
  if (!index || index.entries.length === 0) {
    return { excess: 1, maxSim: 0, nearestId: null, exactDup: false, nearDup: false }
  }

  const print = memoryFingerprint(content)
  const fpHit = index.fingerprints.get(print)
  if (fpHit && fpHit !== excludeId) {
    return {
      excess: 0,
      maxSim: 1,
      nearestId: fpHit,
      exactDup: true,
      nearDup: true,
    }
  }

  const cand = embedLocalText(content)
  const nearest = index.entries.reduce(
    (best, ref, indexPosition) => {
      if (excludeId && ref.id === excludeId) return best
      const similarity = cosineSimilarity(cand, index.vectors[indexPosition]!)
      return similarity > best.maxSim ? { maxSim: similarity, nearestId: ref.id } : best
    },
    { maxSim: 0, nearestId: null as string | null }
  )
  const maxSim = Math.max(0, Math.min(1, nearest.maxSim))
  const nearestId = nearest.nearestId
  const nearDup = maxSim >= NEAR_DUP_SIM
  const excess = nearDup ? 0 : Math.max(0, Math.min(1, 1 - maxSim))

  return { excess, maxSim, nearestId, exactDup: false, nearDup }
}

/**
 * Convenience: build index from R and score one content string.
 */
export function computeExcess(
  content: string,
  reference: MemoryEntry[],
  excludeId?: string
): ExcessResult {
  return excessAgainstIndex(content, buildReferenceIndex(reference), excludeId)
}
