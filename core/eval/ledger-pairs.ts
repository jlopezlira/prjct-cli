/**
 * Ledger → labeled retrieval pairs.
 *
 * The reinforcement ledger already encodes supervision for free: when a NEW
 * entry references an OLDER one (`resolves:`/`relates:`/inline `mem_N`, the same
 * extraction the usefulness loop credits), that older entry is, by the author's
 * own hand, a RELEVANT result for the context the new entry describes. So each
 * reference edge is a labeled pair: query = the citing entry's text, positive =
 * the cited entry. No manual annotation, no LLM judge — author-declared signal.
 *
 * This is the honest benchmark substrate for every retrieval change. It is
 * deliberately conservative (reference edges only, test-scaffolding filtered)
 * so the held-out numbers mean something.
 */

import { isModelMemory, type MemoryEntry } from '../memory/entries'
import { projectMemory } from '../memory/project-memory'
import { extractRefIds } from '../services/usefulness'
import prjctDb from '../storage/database'

/** Inline/test-scaffolding anchors that are not real project knowledge. */
const TEST_NOISE_RE = /REINFORCE-TEST|REINFORCE-FINAL|reinforce-test/i

/** Strip the literal `mem_N` tokens so the query can't leak the target id. */
export function toQueryText(content: string): string {
  return content
    .replace(/\bmem[_-]\d+\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface LabeledPair {
  /** The citing (newer) entry — the query. */
  anchorId: string
  /** Every citing entry represented by this distinct query; none is a candidate. */
  excludeIds?: string[]
  /** Anchor content with `mem_N` tokens stripped — what we actually search. */
  queryText: string
  /** Cited (older) entries that exist in the corpus — the relevant set. */
  positives: string[]
  /** First capture time (ISO) — defines query date cohorts. */
  anchorDate: string
  /** Where the supervision came from. Defaults to explicit author references. */
  source?: 'reference-edge' | 'ship-surfaced'
}

export interface LedgerCorpus {
  /** Every model-worthy entry, the candidate pool a retriever ranks over. */
  entries: MemoryEntry[]
  pairs: LabeledPair[]
}

/**
 * Build the candidate corpus + labeled pairs from a project's memory. Only
 * reference edges where BOTH ends are real, non-deleted, model-worthy entries
 * become positives; anchors/targets that are test scaffolding are dropped.
 */
export function exportLedgerPairs(projectId: string, poolLimit = 100_000): LedgerCorpus {
  const all = projectMemory
    .recall(projectId, { limit: poolLimit })
    .filter((e) => isModelMemory(e) && e.content.trim().length > 0)

  const byId = new Map(all.map((e) => [e.id, e]))
  const pairs: LabeledPair[] = []

  for (const e of all) {
    if (TEST_NOISE_RE.test(e.content)) continue
    const refs = extractRefIds(e.content, e.tags ?? {})
    const positives = refs.filter((id) => {
      if (id === e.id) return false
      const target = byId.get(id)
      return !!target && !TEST_NOISE_RE.test(target.content)
    })
    if (positives.length === 0) continue
    pairs.push({
      anchorId: e.id,
      queryText: toQueryText(e.content),
      positives: [...new Set(positives)],
      anchorDate: e.rememberedAt,
      source: 'reference-edge',
    })
  }

  for (const p of exportStoredEvalPairs(projectId, byId)) pairs.push(p)

  return { entries: all, pairs: groupQueryPairs(pairs) }
}

/** A query with several positives is one case, never several independent samples. */
export function groupQueryPairs(pairs: LabeledPair[]): LabeledPair[] {
  const groups = new Map<string, LabeledPair[]>()
  for (const pair of pairs) {
    const query = toQueryText(pair.queryText)
    if (!query) continue
    const key = JSON.stringify([pair.source ?? 'reference-edge', query])
    const group = groups.get(key) ?? []
    group.push({ ...pair, queryText: query })
    groups.set(key, group)
  }
  return [...groups.values()].flatMap((group) => {
    const ordered = [...group].sort(
      (a, b) => a.anchorDate.localeCompare(b.anchorDate) || a.anchorId.localeCompare(b.anchorId)
    )
    const excluded = new Set(ordered.flatMap((pair) => [pair.anchorId, ...(pair.excludeIds ?? [])]))
    const positives = [...new Set(ordered.flatMap((pair) => pair.positives))]
      .filter((id) => !excluded.has(id))
      .sort()
    return positives.length ? [{ ...ordered[0]!, positives, excludeIds: [...excluded].sort() }] : []
  })
}

interface EvalLabelRow {
  id: number
  query_text: string
  positive_id: string
  source: string
  created_at: string
}

function exportStoredEvalPairs(
  projectId: string,
  byId: ReadonlyMap<string, MemoryEntry>
): LabeledPair[] {
  const rows = (() => {
    try {
      return prjctDb.query<EvalLabelRow>(
        projectId,
        `SELECT id, query_text, positive_id, source, created_at
         FROM retrieval_eval_labels
         ORDER BY created_at ASC, id ASC`
      )
    } catch {
      return []
    }
  })()

  const pairs: LabeledPair[] = []
  const seen = new Set<string>()
  for (const row2 of rows) {
    if (row2.source !== 'reference-edge' && row2.source !== 'ship-surfaced') continue
    const queryText = toQueryText(row2.query_text)
    const target = byId.get(row2.positive_id)
    if (!queryText || !target || TEST_NOISE_RE.test(target.content)) continue
    const key = `${queryText}\u0000${row2.positive_id}\u0000${row2.source}`
    if (seen.has(key)) continue
    seen.add(key)
    pairs.push({
      anchorId: `label_${row2.id}`,
      queryText,
      positives: [row2.positive_id],
      anchorDate: row2.created_at,
      source: row2.source === 'ship-surfaced' ? 'ship-surfaced' : 'reference-edge',
    })
  }
  return pairs
}

export interface TemporalSplit {
  cutoff: string
  train: LabeledPair[]
  evalSet: LabeledPair[]
}

/**
 * Split pairs by anchor date so eval anchors are strictly NEWER than train —
 * a date cohort rather than a historical corpus replay. `evalFraction` is the
 * share of the newest distinct queries held out.
 */
export function temporalSplit(pairs: LabeledPair[], evalFraction = 0.2): TemporalSplit {
  const sorted = [...pairs].sort((a, b) => a.anchorDate.localeCompare(b.anchorDate))
  if (sorted.length === 0) return { cutoff: '', train: [], evalSet: [] }
  const idx = Math.max(1, Math.floor(sorted.length * (1 - evalFraction)))
  const cutoff = sorted[Math.min(idx, sorted.length - 1)].anchorDate
  return {
    cutoff,
    train: sorted.filter((p) => p.anchorDate < cutoff),
    evalSet: sorted.filter((p) => p.anchorDate >= cutoff),
  }
}
