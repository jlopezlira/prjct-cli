/**
 * Reciprocal Rank Fusion — merge ranked lists whose scores are not comparable.
 *
 * The lexical leg (FTS5 BM25) and the semantic leg (cosine over embeddings)
 * produce scores on different scales, so neither a threshold nor a weighted sum
 * is meaningful across them. RRF ignores the scores and fuses on RANK alone:
 *
 *   score(id) = Σ over lists of 1 / (k + rank)      (rank is 1-based)
 *
 * `k` damps the advantage of a single #1 hit, so an id ranked decently by BOTH
 * legs outranks one ranked #1 by a single leg — the property we want, since the
 * previous behavior (prepend every semantic hit ahead of BM25) let a weak
 * semantic match unconditionally beat a strong lexical one. k=60 is the value
 * from Cormack et al. 2009, where it was tuned across TREC collections.
 */

export const RRF_K = 60

export function rrfFuse(lists: ReadonlyArray<readonly string[]>, k: number = RRF_K): string[] {
  const scores = new Map<string, number>()
  // First-seen order breaks ties deterministically (lists are passed in
  // priority order, so the lexical leg wins an exact score tie).
  const order = new Map<string, number>()
  for (const list of lists) {
    list.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1))
      if (!order.has(id)) order.set(id, order.size)
    })
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || (order.get(a[0]) ?? 0) - (order.get(b[0]) ?? 0))
    .map(([id]) => id)
}
