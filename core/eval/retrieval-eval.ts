/**
 * Retrieval eval runner — scores a retriever over the labeled ledger pairs.
 *
 * Provider-agnostic by construction: `evalProvider` takes any EmbeddingProvider
 * (today's local hashing embedder, tomorrow's ONNX pretrained encoder) and the
 * SAME corpus + pairs, so a swap is measured apples-to-apples. The BM25 leg uses
 * the real FTS5 path so the lexical baseline is the one prjct actually serves.
 */

import type { MemoryEntry } from '../memory/entries'
import { projectMemory } from '../memory/project-memory'
import { cosineSimilarity, type EmbeddingProvider } from '../services/embeddings'
import type { LabeledPair } from './ledger-pairs'
import { type AggregateMetrics, aggregate } from './retrieval-metrics'

/** Rank every corpus id (except `excludeId`) by cosine to a query vector. */
function rankByVector(
  queryVec: number[],
  corpusVecs: Array<{ id: string; vec: number[] }>,
  excludeId: string
): string[] {
  return corpusVecs
    .filter((c) => c.id !== excludeId)
    .map((c) => ({ id: c.id, score: cosineSimilarity(queryVec, c.vec) }))
    .sort((a, b) => b.score - a.score)
    .map((c) => c.id)
}

/**
 * Embed the corpus once with `provider`, then for each pair rank the corpus by
 * cosine to the query and score the cited positives. One forward pass over the
 * corpus + one per query — trivial for a project's hundreds of entries.
 */
export async function evalProvider(
  corpus: MemoryEntry[],
  pairs: LabeledPair[],
  provider: EmbeddingProvider,
  k: number
): Promise<AggregateMetrics> {
  const corpusVecs = (await provider.embed(corpus.map((e) => e.content))).map((vec, i) => ({
    id: corpus[i].id,
    vec,
  }))
  const cases: Array<{ ranked: string[]; relevant: Set<string> }> = []
  for (const p of pairs) {
    const [qv] = await provider.embed([p.queryText])
    if (!qv) continue
    const ranked = rankByVector(qv, corpusVecs, p.anchorId)
    cases.push({ ranked, relevant: new Set(p.positives) })
  }
  return aggregate(cases, k)
}

/**
 * BM25 baseline over the real FTS5 index. Queries with the anchor's tokens and
 * scores where the cited positives land. Anchors that the lexical leg can't
 * tokenize (empty after stripping) contribute an empty ranking (a miss), which
 * is the honest outcome.
 */
export function evalBm25(projectId: string, pairs: LabeledPair[], k: number): AggregateMetrics {
  const cases: Array<{ ranked: string[]; relevant: Set<string> }> = []
  for (const p of pairs) {
    const keywords = p.queryText
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .slice(0, 32)
    const ranked = (() => {
      try {
        return projectMemory
          .searchFts(projectId, keywords, 100)
          .map((entry) => entry.id)
          .filter((id) => id !== p.anchorId)
      } catch {
        return []
      }
    })()
    cases.push({ ranked, relevant: new Set(p.positives) })
  }
  return aggregate(cases, k)
}
