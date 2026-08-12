/**
 * Memory entry model — types, row mapping, and pure entry filters.
 *
 * Extracted from project-memory.ts (god-file split). Everything here is
 * pure data + functions over rows/entries: no DB access, no services.
 * The query surface (`projectMemory`) lives in project-memory.ts; the
 * markdown rendering in format.ts.
 */

/**
 * Sovereign knowledge-base facets — the model-agnostic project knowledge
 * (identity, voice, glossary, frameworks) any LLM brain reads on demand.
 * Authored in SQLite via `prjct remember <facet> "..."`, recalled via
 * `prjct context memory <facet>` / search, and projected to the vault as
 * first-class per-entry notes + a cohesive `knowledge.md` index. This is the
 * "knowledge base" pillar of the harness: rules/knowledge live in prjct, never
 * injected into client-repo surfaces (clean-repo doctrine). Single source of
 * truth — the vault projection (memory-builder `PER_ENTRY_TYPES`) imports this
 * list so capture and projection can never drift.
 */
export const KB_MEMORY_TYPES = ['identity', 'voice', 'glossary', 'framework'] as const

/**
 * Base memory types. Additional types come from `packs/*` manifests;
 * user-invented types persist as freeform strings (`MemoryType = string`).
 */
export const BASE_MEMORY_TYPES = [
  // Code-centric (always useful — kept from v1 for continuity)
  'fact',
  'decision',
  'learning',
  'gotcha',
  /**
   * Negative knowledge — "not the cause" / red herring. First-class so
   * discarded hypotheses stay visible (not buried inside generic gotcha).
   * Differentiator vs trackers that only store decisions that shipped.
   */
  'red-herring',
  'pattern',
  'anti-pattern',
  'shipped',
  // Selective few-shot guidance. Valid examples carry authored
  // domain + polarity=good|bad tags and are only pushed on a topical match.
  'example',
  // Sovereign knowledge base — see KB_MEMORY_TYPES.
  ...KB_MEMORY_TYPES,
  // The history of contexts: one rich, git-linked entry per task — what
  // happened, why (the sentiment), the decision, the trap, the outcome. The
  // recoverable unit of the project's "second brain" RAG. Embedded by default
  // (isModelMemory), surfaced on demand when a related task starts.
  'context',
  // GTD / day-to-day (capture, triage, review)
  'inbox',
  'todo',
  'idea',
  // PM / Research (insights, questions, sources)
  'insight',
  'question',
  'source',
  // Founder / Ops (people, stakeholders, goals)
  'person',
  // SDD: spec is the artifact that frames work BEFORE implementation.
  // Authoritative storage is the `specs` table; a memory event is also
  // emitted on creation so specs surface in `prjct context memory spec`.
  'spec',
] as const

/** @deprecated use BASE_MEMORY_TYPES. Kept as alias for backward compat. */
export const MEMORY_TYPES = BASE_MEMORY_TYPES

/** Freeform memory type — any non-empty string. */
export type MemoryType = string

/**
 * Where an entry came from. Lets Claude calibrate trust:
 *   declared  — user / LLM wrote this via `prjct remember`
 *   extracted — auto-recorded from verifiable project state (ships, tags)
 *   inferred  — pattern-extractor or heuristic guess; weakest signal
 *   ambiguous — mixed provenance or confidence unclear
 */
export type MemoryProvenance = 'declared' | 'extracted' | 'inferred' | 'ambiguous'

export interface MemoryEntry {
  /** Stable identifier for `prjct remember forget <id>` */
  id: string
  type: MemoryType
  content: string
  tags: Record<string, string>
  /** ISO8601 */
  rememberedAt: string
  /** Task id that captured this, if any */
  source?: string
  provenance: MemoryProvenance
}

/**
 * Is this entry knowledge that MODELS the project/developer — worth embedding
 * for semantic recall — or auto-generated telemetry that is noise?
 *
 * Per the RAG north star, the point is a model that anticipates, not bulk
 * vectorization. Two classes of high-volume / low-signal noise are excluded:
 *   - `improvement-signal` — raw friction / skill-miss captures. They feed the
 *     DEVELOPER PROFILE (synthesized separately), not semantic recall, where
 *     near-duplicate pushbacks would only dilute results.
 *   - `pattern: hot-file` — "file changed N times this week" churn counters.
 * Everything else (decisions, gotchas, learnings, facts, feedback, recurring
 * bug patterns, ingested sources, specs) builds the model and is embedded.
 */
export function isModelMemory(entry: Pick<MemoryEntry, 'type' | 'tags'>): boolean {
  if (entry.type === 'improvement-signal') return false
  if (entry.tags?.pattern === 'hot-file') return false
  return true
}

export interface ShippedRow {
  id: string
  name: string
  type: string | null
  shipped_at: string
  data: string | null
}

export function safeJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

// rowToEntry (events row → MemoryEntry) was removed in the C1 single-source
// cutover: every authored-memory reader now reads the typed memory_entries
// tables (see project-memory.loadV2Entries), so nothing parses events.data into
// a MemoryEntry anymore.

export function shippedRowToEntry(row: ShippedRow): MemoryEntry {
  const meta = row.data
    ? safeJson<{ tags?: Record<string, string>; taskId?: string }>(row.data, {})
    : {}
  const tagBase: Record<string, string> = meta.tags ?? {}
  if (row.type) tagBase.type = row.type
  // Ships are verifiable project state — high-confidence extracted signal.
  return {
    id: `ship_${row.id}`,
    type: 'shipped',
    content: row.name,
    tags: tagBase,
    rememberedAt: row.shipped_at,
    source: meta.taskId,
    provenance: 'extracted',
  }
}

export function matchesTopic(entry: MemoryEntry, topic: string): boolean {
  const t = topic.toLowerCase()
  if (entry.content.toLowerCase().includes(t)) return true
  for (const v of Object.values(entry.tags)) {
    if (v.toLowerCase().includes(t)) return true
  }
  return false
}

export function matchesTags(entry: MemoryEntry, tags: Record<string, string>): boolean {
  for (const [k, v] of Object.entries(tags)) {
    if (entry.tags[k] !== v) return false
  }
  return true
}

/**
 * Collapse entries that share `(type, tags.key)` down to the newest one.
 * `entries` must already be sorted newest-first — this function preserves
 * the input order and drops later (older) duplicates per group. Entries
 * without a `key` tag are passed through unchanged.
 */
export function dedupeLatestByKey(entries: MemoryEntry[]): MemoryEntry[] {
  const seen = new Set<string>()
  const out: MemoryEntry[] = []
  for (const entry of entries) {
    const key = entry.tags.key
    if (!key) {
      out.push(entry)
      continue
    }
    const groupId = `${entry.type}::${key}`
    if (seen.has(groupId)) continue
    seen.add(groupId)
    out.push(entry)
  }
  return out
}

const MEM_REF_RE = /\bmem[_-](\d+)\b/g

/**
 * Collect the ids that the author has explicitly declared obsolete, from
 * the relationships present in `entries`:
 *   - an entry tagged `supersedes:mem_X` (or `duplicates:mem_X`) marks X dead
 *     — the newer/canonical entry replaces it;
 *   - an entry tagged `superseded-by:…` marks ITSELF dead — it points forward
 *     to its replacement.
 *
 * This is author-declared compaction, not a heuristic: nothing is pruned
 * unless someone wrote the relationship down. Scoped to the supplied window
 * (no extra query on the recall hot path); the superseding entry is almost
 * always newer than — and thus recalled alongside — the one it replaces.
 */
export function collectSupersededIds(entries: MemoryEntry[]): Set<string> {
  const dead = new Set<string>()
  for (const entry of entries) {
    if (entry.tags['superseded-by']) dead.add(entry.id)
    for (const key of ['supersedes', 'duplicates']) {
      const v = entry.tags[key]
      if (!v) continue
      for (const m of String(v).matchAll(MEM_REF_RE)) dead.add(`mem_${m[1]}`)
    }
  }
  return dead
}
