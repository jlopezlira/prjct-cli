/**
 * File Ranker — Combined Scoring
 *
 * Combines every signal in the indexer registry to rank files by
 * relevance to a task description. The registry contains:
 *   - BM25 text search        (query-driven)
 *   - Symbol-name match       (query-driven — functions/classes/routes)
 *   - Import graph proximity  (seed-driven)
 *   - Git co-change           (seed-driven)
 *
 * Adding a new signal is a one-file change in `./indexers/registry.ts`.
 * Zero API calls. Pure math on pre-built indexes.
 *
 * Algorithm:
 * 1. Run every query indexer to build candidates (BM25 + symbols).
 * 2. Merge top candidates as seed files for graph traversal.
 * 3. Run every seed indexer over those seeds.
 * 4. Combine: finalScore = Σ (signal × weight).
 *
 * Performance target: <50ms per query (all indexes pre-loaded from SQLite).
 */

import type { RankedFile, RankingConfig } from '../types/domain.js'
import { indexerRegistry, type QueryIndexer, type SeedIndexer } from './indexers/registry'

const DEFAULT_CONFIG: Required<RankingConfig> = {
  bm25Weight: 0.45,
  importWeight: 0.2,
  cochangeWeight: 0.15,
  symbolsWeight: 0.2,
  topN: 15,
  importDepth: 2,
}

const SEED_FILE_LIMIT = 10

export function rankFiles(
  projectId: string,
  query: string,
  config: RankingConfig = {}
): RankedFile[] {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const weights: Record<string, number> = {
    bm25: cfg.bm25Weight,
    symbols: cfg.symbolsWeight,
    imports: cfg.importWeight,
    cochange: cfg.cochangeWeight,
  }

  const queryIndexers = indexerRegistry.filter((i): i is QueryIndexer => i.kind === 'query')
  const seedIndexers = indexerRegistry.filter((i): i is SeedIndexer => i.kind === 'seed')

  // Run every query-driven indexer; merge seeds from all of them (union of top hits).
  const scoresByIndexer = new Map<string, Map<string, number>>()
  const seedScores = new Map<string, number>()
  for (const idx of queryIndexers) {
    const scores = idx.scoreFromQuery(projectId, query, cfg.topN * 3)
    if (scores.length === 0) continue
    scoresByIndexer.set(idx.name, new Map(scores.map((s) => [s.path, s.score])))
    for (const s of scores.slice(0, SEED_FILE_LIMIT)) {
      seedScores.set(s.path, Math.max(seedScores.get(s.path) ?? 0, s.score))
    }
  }
  if (scoresByIndexer.size === 0) return []

  const seedFiles = [...seedScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, SEED_FILE_LIMIT)
    .map(([p]) => p)

  for (const idx2 of seedIndexers) {
    const scores = idx2.scoreFromSeeds(projectId, seedFiles, {
      importDepth: cfg.importDepth,
    })
    if (scores.length === 0) continue
    scoresByIndexer.set(idx2.name, new Map(scores.map((s) => [s.path, s.score])))
  }

  const allFiles = new Set<string>()
  for (const map of scoresByIndexer.values()) {
    for (const k of map.keys()) allFiles.add(k)
  }

  const ranked: RankedFile[] = []
  for (const filePath of allFiles) {
    const finalScore = [...scoresByIndexer].reduce((total, [name, map]) => {
      const score = map.get(filePath) ?? 0
      const weight =
        weights[name] ??
        indexerRegistry.find((indexer) => indexer.name === name)?.defaultWeight ??
        0
      return total + score * weight
    }, 0)
    ranked.push({
      path: filePath,
      finalScore,
      signals: {
        bm25: scoresByIndexer.get('bm25')?.get(filePath) ?? 0,
        imports: scoresByIndexer.get('imports')?.get(filePath) ?? 0,
        cochange: scoresByIndexer.get('cochange')?.get(filePath) ?? 0,
        symbols: scoresByIndexer.get('symbols')?.get(filePath) ?? 0,
      },
    })
  }

  ranked.sort((a, b) => b.finalScore - a.finalScore)
  return ranked.slice(0, cfg.topN)
}

/**
 * Check whether each registered index has data for this project.
 * Public shape (`bm25`, `imports`, `cochange`) is preserved for
 * existing callers (CLI / tests). `symbols` is additive.
 */
export function hasIndexes(projectId: string): {
  bm25: boolean
  imports: boolean
  cochange: boolean
  symbols: boolean
} {
  const presence: Record<string, boolean> = {}
  for (const idx of indexerRegistry) {
    presence[idx.name] = idx.hasIndex(projectId)
  }
  return {
    bm25: presence.bm25 ?? false,
    imports: presence.imports ?? false,
    cochange: presence.cochange ?? false,
    symbols: presence.symbols ?? false,
  }
}
