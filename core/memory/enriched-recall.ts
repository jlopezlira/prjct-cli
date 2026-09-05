/**
 * Enriched recall — the ONE retrieval pipeline every agent surface uses.
 *
 * FTS5 BM25 first (relevance beats recency), recency-recall backfill,
 * optional semantic blend (when an embeddings provider is configured),
 * bounded usefulness rerank, one hop of relationship-link expansion, and
 * ship-success surface attribution.
 *
 * Extracted from `runMemoryTool` (the `prjct context memory` CLI path) so
 * the MCP tools stop serving a strictly WORSE retrieval: `prjct_mem_list`
 * used plain recency `recall()` — and subagents, who do the bulk of the
 * editing, reach memory through MCP. One pipeline, every surface.
 */

import configManager from '../infrastructure/config-manager'
import { embeddingService } from '../services/embeddings'
import { usefulnessService } from '../services/usefulness'
import { stateStorage } from '../storage/state-storage'
import type { LocalConfig } from '../types/config'
import type { MemoryEntry, MemoryType } from './entries'
import { isModelMemory, matchesTags } from './entries'
import { projectMemory } from './project-memory'
import { rrfFuse } from './rank-fusion'

export interface EnrichedRecallOpts {
  topic?: string
  types?: MemoryType[]
  /** Require exact match on these k:v pairs (applies to every leg). */
  tags?: Record<string, string>
  limit?: number
  /** Append one hop of resolves/relates/supersedes links. Default true. */
  expandLinks?: boolean
  /** Evaluation must not credit the entries it measures. */
  recordAttribution?: boolean
  excludeIds?: readonly string[]
  allowedIds?: ReadonlySet<string>
  nowMs?: number
  configSnapshot?: LocalConfig | null
}

export async function enrichedRecall(
  projectPath: string,
  projectId: string,
  opts: EnrichedRecallOpts = {}
): Promise<MemoryEntry[]> {
  const { topic, types, tags } = opts
  const limit = Math.max(0, Math.min(1000, Math.floor(opts.limit ?? 30)))
  if (!Number.isFinite(limit) || limit === 0) return []
  const { isAutoSource } = await import('../services/retention/purge')
  const now = opts.nowMs ?? Date.now()
  const excluded = new Set(opts.excludeIds ?? [])
  const eligible = (entry: MemoryEntry): boolean => {
    if (excluded.has(entry.id) || (opts.allowedIds && !opts.allowedIds.has(entry.id))) return false
    if (types && !types.includes(entry.type as MemoryType)) return false
    if (tags && !matchesTags(entry, tags)) return false
    if (!isModelMemory(entry) && !types?.includes(entry.type as MemoryType)) return false
    const timestamp = Date.parse(entry.rememberedAt)
    return (
      Boolean(types?.includes('improvement-signal' as MemoryType)) ||
      !isAutoSource(entry.tags?.source) ||
      !Number.isFinite(timestamp) ||
      now - timestamp < 45 * 86_400_000
    )
  }

  const lexicalEntries = topic
    ? (() => {
        const keywords = topic.split(/\s+/).filter(Boolean)
        try {
          const fts = projectMemory.searchFts(projectId, keywords, limit, {
            types,
            tags,
            accept: eligible,
          })
          return fts.filter(eligible)
        } catch {
          return []
        }
      })()
    : []

  // Backfill ONLY when the topical leg found NOTHING — a fresh/unindexed DB,
  // a cross-vocabulary topic, or no topic at all (recent-memory listing).
  // Padding a HEALTHY FTS result set up to `limit` with recency/substring
  // matches injected off-topic noise (a "token efficiency" search dragging in
  // an unrelated recent decision). Selective beats full: relevance leads, the
  // agent pulls more by id or refines the topic (mem_1012).
  const backfilledEntries =
    lexicalEntries.length > 0
      ? lexicalEntries
      : projectMemory
          .recall(projectId, { topic, types, tags, limit })
          .filter(eligible)
          .slice(0, limit)

  // Semantic layer (opt-in), fused by RANK not by prepending: a cross-vocabulary
  // hit ("oauth" → an entry about "authentication") must be able to surface,
  // but the old behavior put EVERY semantic hit ahead of BM25, so a weak
  // semantic match outranked a strong lexical one. RRF makes an entry both legs
  // rank decently beat one leg's lone favourite. Measured on this project's
  // 1400 labeled pairs, held-out: nDCG 17.4% (BM25) / 23.2% (semantic alone) →
  // 24.3% fused, MRR 13.5% / 16.3% → 18.3% (`prjct harness retrieval`).
  // Best-effort: any failure leaves the lexical result standing.
  const semanticEntries = topic
    ? await (async () => {
        try {
          const config =
            opts.configSnapshot !== undefined
              ? opts.configSnapshot
              : await configManager.readConfig(projectPath)
          if (config && embeddingService.isEnabled(config)) {
            const semantic = await embeddingService.semanticSearch(
              projectId,
              topic,
              config,
              10,
              undefined,
              eligible
            )
            const semanticEligible = semantic.filter(eligible)
            if (semanticEligible.length > 0) {
              const byId = new Map(backfilledEntries.map((entry) => [entry.id, entry]))
              for (const entry of semanticEligible) {
                if (!byId.has(entry.id)) byId.set(entry.id, entry)
              }
              return rrfFuse([
                backfilledEntries.map((entry) => entry.id),
                semanticEligible.map((entry) => entry.id),
              ])
                .flatMap((id) => {
                  const entry = byId.get(id)
                  return entry ? [entry] : []
                })
                .slice(0, limit)
            }
          }
          return backfilledEntries
        } catch {
          return backfilledEntries
        }
      })()
    : backfilledEntries

  const kept = semanticEntries.filter(eligible)
  const ageFilteredEntries = types?.includes('improvement-signal' as MemoryType)
    ? kept
    : [
        ...kept.filter((entry) => !isAutoSource(entry.tags?.source)),
        ...kept.filter((entry) => isAutoSource(entry.tags?.source)),
      ]

  // Reinforcement: nudge proven-useful entries up (bounded — relevance
  // still leads). This is how recall gets smarter with use.
  const rerankedEntries =
    ageFilteredEntries.length > 1
      ? usefulnessService.rerank(projectId, ageFilteredEntries)
      : ageFilteredEntries

  // One hop of relationship-graph traversal so a recall carries its own
  // context instead of dangling `mem_N` pointers the agent must chase.
  const linked =
    opts.expandLinks !== false && rerankedEntries.length > 0
      ? projectMemory.expandWithLinks(projectId, rerankedEntries, 5, eligible)
      : []
  const entries = [
    ...new Map(
      [...rerankedEntries, ...linked.filter(eligible)].map((entry) => [entry.id, entry])
    ).values(),
  ].slice(0, limit)

  // Attribution: record which entries were surfaced for the active task so a
  // successful ship credits them (+SHIP). Deliberately NO per-entry fetch
  // credit here — a broad recall returns many entries the agent never uses, so
  // crediting all of them inflates the very "useful" signal retention consumes
  // to decide what to keep. Usefulness is earned by a later citation (+REF) or
  // a ship, not by the act of being surfaced by a query.
  try {
    const task =
      opts.recordAttribution === false ? null : await stateStorage.getCurrentTask(projectId)
    if (task?.id) {
      usefulnessService.recordSurfaced(
        projectId,
        entries.map((e) => e.id),
        task.id,
        new Date().toISOString(),
        { queryText: topic, surface: 'context-memory' }
      )
    }
  } catch {
    /* best-effort — attribution telemetry must never break a recall */
  }

  return entries
}
