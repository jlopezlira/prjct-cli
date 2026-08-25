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
import type { MemoryEntry, MemoryType } from './entries'
import { isModelMemory, matchesTags } from './entries'
import { projectMemory } from './project-memory'
import { rrfFuse } from './rank-fusion'

/** Judgment types never dropped from inject solely for verdict=delete. */
const PROTECTED_INJECT = new Set(['decision', 'gotcha', 'learning', 'fact', 'feedback', 'spec'])

export interface EnrichedRecallOpts {
  topic?: string
  types?: MemoryType[]
  /** Require exact match on these k:v pairs (applies to every leg). */
  tags?: Record<string, string>
  limit?: number
  /** Append one hop of resolves/relates/supersedes links. Default true. */
  expandLinks?: boolean
}

export async function enrichedRecall(
  projectPath: string,
  projectId: string,
  opts: EnrichedRecallOpts = {}
): Promise<MemoryEntry[]> {
  const { topic, types, tags } = opts
  const limit = opts.limit ?? 30

  const lexicalEntries = topic
    ? (() => {
        const keywords = topic.split(/\s+/).filter(Boolean)
        try {
          const fts = projectMemory.searchFts(projectId, keywords, limit)
          return fts.filter(
            (entry) =>
              (!types || types.includes(entry.type as MemoryType)) &&
              (!tags || matchesTags(entry, tags))
          )
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
      : projectMemory.recall(projectId, { topic, types, tags, limit }).slice(0, limit)

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
          const config = await configManager.readConfig(projectPath)
          if (config && embeddingService.isEnabled(config)) {
            const semantic = await embeddingService.semanticSearch(projectId, topic, config, 10)
            const eligible = semantic.filter(
              (entry) =>
                (!types || types.includes(entry.type as MemoryType)) &&
                (!tags || matchesTags(entry, tags))
            )
            if (eligible.length > 0) {
              const byId = new Map(backfilledEntries.map((entry) => [entry.id, entry]))
              for (const entry of eligible) {
                if (!byId.has(entry.id)) byId.set(entry.id, entry)
              }
              return rrfFuse([
                backfilledEntries.map((entry) => entry.id),
                eligible.map((entry) => entry.id),
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

  // Clean the RAG: drop machine telemetry noise (raw friction quotes,
  // hot-file churn counters) so a recall returns project KNOWLEDGE, not basura.
  // Retrocompatible + non-destructive — the rows stay (audit / developer.md),
  // they just don't surface as context. Skipped when the caller EXPLICITLY asked
  // for one of those types (e.g. the dev-profile builder).
  const modelEntries = semanticEntries.filter(
    (e) => isModelMemory(e) || (types?.includes(e.type as MemoryType) ?? false)
  )

  // Inject filter (cheap, hot-path safe): drop aged auto-source noise so
  // agents don't re-read detector history. Full Rho evaluate stays on sync.
  // Explicit improvement-signal type requests skip this.
  const ageFilteredEntries = !types?.includes('improvement-signal' as MemoryType)
    ? await (async () => {
        try {
          const { isAutoSource } = await import('../services/retention/purge')
          const AUTO_INJECT_MAX_AGE_MS = 45 * 86_400_000
          const now = Date.now()
          const kept = modelEntries.filter((e) => {
            if (!isAutoSource(e.tags?.source)) return true
            if (PROTECTED_INJECT.has(e.type) && !isAutoSource(e.tags?.source)) return true
            const t = Date.parse(e.rememberedAt)
            if (!Number.isFinite(t)) return true
            return now - t < AUTO_INJECT_MAX_AGE_MS
          })
          // Prefer non-auto first (stable partition), then original order within
          const nonAuto = kept.filter((e) => !isAutoSource(e.tags?.source))
          const auto = kept.filter((e) => isAutoSource(e.tags?.source))
          return [...nonAuto, ...auto].slice(0, Math.max(limit, kept.length))
        } catch {
          return modelEntries
        }
      })()
    : modelEntries

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
      ? projectMemory.expandWithLinks(projectId, rerankedEntries, 5)
      : []
  const entries = linked.length > 0 ? rerankedEntries.concat(linked) : rerankedEntries

  // Attribution: record which entries were surfaced for the active task so a
  // successful ship credits them (+SHIP). Deliberately NO per-entry fetch
  // credit here — a broad recall returns many entries the agent never uses, so
  // crediting all of them inflates the very "useful" signal retention consumes
  // to decide what to keep. Usefulness is earned by a later citation (+REF) or
  // a ship, not by the act of being surfaced by a query.
  try {
    const task = await stateStorage.getCurrentTask(projectId)
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
