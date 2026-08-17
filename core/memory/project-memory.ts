/**
 * Project Memory API — the v2 "super memory" layer.
 *
 * One unified surface over the memory sources that were scattered across
 * services: the events table (prjct_mem_save), `shipped_features`,
 * `confirmed_classifications`, and pattern extraction. Built so an LLM can
 * ask a single question ("what do you know about auth?") and get back a
 * dense, filtered answer.
 *
 * Entry types:
 *   fact          — something true about the project
 *   decision      — choice made and rationale (why, not what)
 *   learning      — lesson from a mistake or surprise
 *   gotcha        — non-obvious trap for future readers
 *   red-herring   — negative knowledge: not-the-cause / discarded hypothesis
 *   pattern       — recurring technique that works here
 *   anti-pattern  — technique that hurt us and should be avoided
 *   shipped       — auto-recorded when a task ships
 *
 * Storage: reuses the events table via memoryService (type prefix
 * `remember.<type>`) for user-captured entries, plus `shipped_features`
 * for auto-recorded ships.
 */

import { memoryService } from '../services/memory-service'
import prjctDb from '../storage/database'
import { deburr } from '../utils/deburr'
import { memoryFingerprint } from './content-fingerprint'
import {
  collectSupersededIds,
  dedupeLatestByKey,
  type MemoryEntry,
  type MemoryProvenance,
  type MemoryType,
  matchesTags,
  matchesTopic,
  type ShippedRow,
  shippedRowToEntry,
} from './entries'
import { REMEMBER_ACTION_PREFIX, REMEMBER_EVENT_PREFIX } from './events'

/**
 * Cheap content stamp over the three tables `allEntriesForIndex` reads
 * (memory_entries + memory_entry_tags + shipped_features). Any write that can
 * change the read model — insert (count/rowid), soft delete (deleted_at),
 * hard delete (count), tag write (count/rowid) — moves the stamp, so caches
 * keyed by it invalidate implicitly without hooking every write path.
 * In-place UPDATEs of unselected columns (topic_key, revision_count) cannot
 * alter the mapped entries and intentionally do not move the stamp.
 */
export function memoryVaultStamp(projectId: string): string {
  const row = prjctDb.get<{
    memCount: number
    memMaxRowid: number | null
    memDeleted: number
    memMaxDeleted: number | null
    tagCount: number
    tagMaxRowid: number | null
    shipCount: number
    shipMaxRowid: number | null
  }>(
    projectId,
    `SELECT
       (SELECT COUNT(*) FROM memory_entries) AS memCount,
       (SELECT MAX(rowid) FROM memory_entries) AS memMaxRowid,
       (SELECT COUNT(deleted_at) FROM memory_entries) AS memDeleted,
       (SELECT MAX(deleted_at) FROM memory_entries) AS memMaxDeleted,
       (SELECT COUNT(*) FROM memory_entry_tags) AS tagCount,
       (SELECT MAX(rowid) FROM memory_entry_tags) AS tagMaxRowid,
       (SELECT COUNT(*) FROM shipped_features) AS shipCount,
       (SELECT MAX(rowid) FROM shipped_features) AS shipMaxRowid`
  )
  if (!row) return 'empty'
  return [
    row.memCount,
    row.memMaxRowid ?? 0,
    row.memDeleted,
    row.memMaxDeleted ?? 0,
    row.tagCount,
    row.tagMaxRowid ?? 0,
    row.shipCount,
    row.shipMaxRowid ?? 0,
  ].join(':')
}

/**
 * Per-process snapshot of the allEntriesForIndex read model, keyed by
 * projectId and validated against memoryVaultStamp on every access. One sync
 * reads the vault ~10× (context-quality, retention, triage, purge, health,
 * distill); only the first read pays the full load.
 */
interface VaultSnapshot {
  stamp: string
  entries: MemoryEntry[]
}
const vaultSnapshots = new Map<string, VaultSnapshot>()

interface RecallOpts {
  /** Fuzzy-match against content + tag values */
  topic?: string
  /** Require all these tags (exact match) */
  tags?: Record<string, string>
  /** Restrict to these types */
  types?: MemoryType[]
  /** Max entries to return (default 25) */
  limit?: number
  /**
   * Collapse entries that share `(type, tags.key)` to the newest one.
   * Entries without a `key` tag are unaffected. Default: true.
   *
   * Rationale: callers who `prjct remember` the same conceptual fact
   * with the same `key` repeatedly (e.g. an updated decision) should
   * see the latest assertion, not a stack of stale duplicates. Same
   * "latest winner per key" pattern gstack uses in
   * `gstack-learnings-search` (garrytan/gstack).
   */
  dedupeByKey?: boolean

  /**
   * Drop entries the author explicitly marked obsolete — an entry tagged
   * `supersedes:mem_X` / `duplicates:mem_X` retires X, and an entry tagged
   * `superseded-by:…` retires itself. Author-declared compaction, not a
   * heuristic. Default: true. Set false for the link/index layer, which
   * must keep retired entries resolvable so their wikilinks don't rot.
   */
  pruneSuperseded?: boolean
}

const DEFAULT_RECALL_LIMIT = 25
/** Row-count multiplier to give in-memory filters room to work. */
const OVERFETCH_FACTOR = 4
const MIN_OVERFETCH = 100

/**
 * The exact relationship-tag keys collectSupersededIds (entries.ts) reads —
 * kept in sync with that function's `['supersedes', 'duplicates']` loop and
 * its `'superseded-by'` check.
 */
const SUPERSEDE_TAG_KEYS = ['supersedes', 'duplicates', 'superseded-by']

function getOrCreateMapValue<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  const existing = map.get(key)
  if (existing !== undefined) return existing
  const value = create()
  map.set(key, value)
  return value
}

/**
 * Dead-id set for the FTS mirror: every entry retired by an author-declared
 * relationship tag, regardless of result window. Scans only live rows whose
 * tags match a relationship key exactly (an indexed IN lookup via
 * ix_tag_lookup(key, value) — this used to be a leading-wildcard LIKE, which
 * can't use that index and forced a full table scan on this per-prompt hot
 * path). Best-effort: empty set on error.
 */
function collectMirrorSupersededIds(projectId: string): Set<string> {
  try {
    // Single-source: relationship tags live in memory_entry_tags now (no JSON
    // LIKE over a blob). Reassemble {id → tags} for the relationship keys only.
    const placeholders = SUPERSEDE_TAG_KEYS.map(() => '?').join(',')
    const rows = prjctDb.query<{ entry_id: string; key: string; value: string }>(
      projectId,
      `SELECT t.entry_id, t.key, t.value
         FROM memory_entry_tags t
         JOIN memory_entries m ON m.id = t.entry_id
        WHERE m.deleted_at IS NULL
          AND t.is_machine = 0
          AND t.key IN (${placeholders})`,
      ...SUPERSEDE_TAG_KEYS
    )
    const byId = new Map<string, Record<string, string>>()
    for (const r of rows) {
      const tags = getOrCreateMapValue(byId, r.entry_id, (): Record<string, string> => ({}))
      tags[r.key] = r.value
    }
    const pseudo: Pick<MemoryEntry, 'id' | 'tags'>[] = [...byId.entries()].map(([id, tags]) => ({
      id,
      tags,
    }))
    return collectSupersededIds(pseudo as MemoryEntry[])
  } catch {
    return new Set()
  }
}

/**
 * Batch-load tags for a set of memory_entries ids — one query
 * (`WHERE entry_id IN (...)`) instead of one per row. Shared by every reader
 * that assembles MemoryEntry.tags (loadV2Entries, searchFts) so a future fix
 * (chunking past SQLite's ~999-param IN limit, excluding is_machine tags,
 * etc.) applies everywhere at once instead of drifting between copies.
 */
function batchTagsByEntryId(projectId: string, ids: string[]): Map<string, Record<string, string>> {
  const tagsById = new Map<string, Record<string, string>>()
  if (ids.length === 0) return tagsById
  const placeholders = ids.map(() => '?').join(',')
  const tagRows = prjctDb.query<{ entry_id: string; key: string; value: string }>(
    projectId,
    `SELECT entry_id, key, value FROM memory_entry_tags WHERE entry_id IN (${placeholders})`,
    ...ids
  )
  for (const t of tagRows) {
    const m = getOrCreateMapValue(tagsById, t.entry_id, (): Record<string, string> => ({}))
    m[t.key] = t.value
  }
  return tagsById
}

/**
 * Read authored memory from the Schema v2 tables (memory_entries +
 * memory_entry_tags), mapped to MemoryEntry. One indexed query for the rows +
 * one batched query for their tags — no JSON.parse per row. `memory_entries` is
 * the single read source; the trigger keeps it complete for every writer.
 * `whereTail` is the part after `WHERE deleted_at IS NULL` (e.g. `AND type = ?
 * ORDER BY ... LIMIT ?`); `params` binds its placeholders.
 */
function loadV2Entries(
  projectId: string,
  whereTail: string,
  ...params: Array<string | number>
): MemoryEntry[] {
  const rows = prjctDb.query<{
    id: string
    type: string
    content: string
    provenance: string | null
    created_at: number
  }>(
    projectId,
    `SELECT id, type, content, provenance, created_at
     FROM memory_entries
     WHERE deleted_at IS NULL ${whereTail}`,
    ...params
  )
  if (rows.length === 0) return []
  const tagsById = batchTagsByEntryId(
    projectId,
    rows.map((r) => r.id)
  )
  return rows.map((r) => ({
    id: r.id,
    type: r.type as MemoryType,
    content: r.content,
    tags: tagsById.get(r.id) ?? {},
    rememberedAt: new Date(r.created_at).toISOString(),
    provenance: (r.provenance ?? 'declared') as MemoryProvenance,
  }))
}

/**
 * Newest-first recall over all live entries (rowid = numeric insert order).
 * When `types` is given (the common case — most callers filter to 1-2 types),
 * the predicate is pushed into SQL so `ix_mem_recall(project_id, type,
 * created_at DESC)` can drive an indexed SEARCH instead of a full SCAN — this
 * was previously JS-side-only, so every recall() (typed or not) scanned the
 * whole table regardless of the caller's filter.
 */
function recallEntriesFromV2(
  projectId: string,
  overfetch: number,
  types?: MemoryType[]
): MemoryEntry[] {
  if (types && types.length > 0) {
    const placeholders = types.map(() => '?').join(',')
    return loadV2Entries(
      projectId,
      `AND type IN (${placeholders}) ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      ...types,
      overfetch
    )
  }
  return loadV2Entries(projectId, 'ORDER BY created_at DESC, rowid DESC LIMIT ?', overfetch)
}

export const projectMemory = {
  /**
   * Store-level topic supersession (write-side upsert): stamp `topic_key` +
   * revision lineage on the topic's CURRENT entry (matched by content_hash)
   * and soft-delete the topic's other active revisions of the same type.
   * Shared by the fresh-capture path and the dedup-hit fold-in path.
   * Best-effort — never blocks a capture.
   */
  applyTopicSupersession(
    projectId: string,
    type: string,
    contentHash: string,
    topicKey: string
  ): void {
    try {
      const priorRevisions =
        prjctDb.get<{ c: number }>(
          projectId,
          `SELECT COUNT(*) AS c FROM memory_entries
           WHERE project_id = ? AND type = ? AND content_hash != ?
             AND (topic_key = ? OR id IN (
               SELECT entry_id FROM memory_entry_tags WHERE key IN ('topic', 'key') AND value = ?
             ))`,
          projectId,
          type,
          contentHash,
          topicKey,
          topicKey
        )?.c ?? 0
      prjctDb.run(
        projectId,
        `UPDATE memory_entries SET topic_key = ?, revision_count = ?
         WHERE project_id = ? AND type = ? AND content_hash = ? AND deleted_at IS NULL`,
        topicKey,
        priorRevisions,
        projectId,
        type,
        contentHash
      )
      prjctDb.run(
        projectId,
        `UPDATE memory_entries SET deleted_at = ?
         WHERE project_id = ? AND type = ? AND deleted_at IS NULL AND content_hash != ?
           AND (topic_key = ? OR id IN (
             SELECT entry_id FROM memory_entry_tags WHERE key IN ('topic', 'key') AND value = ?
           ))`,
        Date.now(),
        projectId,
        type,
        contentHash,
        topicKey,
        topicKey
      )
    } catch {
      /* supersession is best-effort — never block a capture */
    }
  },

  /**
   * Store an entry. Thin wrapper over memoryService so callers don't need
   * to know the event-type prefix convention.
   */
  async remember(
    projectPath: string,
    args: {
      type: MemoryType
      content: string
      tags?: Record<string, string>
      source?: string
      /** Defaults to `declared` — user/LLM asserted this directly. */
      provenance?: MemoryProvenance
      /** Skips the config read when the caller already resolved it — the
       *  Stop-hook detectors fire several remembers per turn and each used
       *  to re-read + re-parse prjct.config.json. */
      projectId?: string
      /** For user-facing remember commands, the event write is the operation. */
      requireWrite?: boolean
      /**
       * Bypass trust-boundary secrets/injection checks (CLI `--force` /
       * MCP force=true). Default false — SoT defense-in-depth so detector
       * paths cannot write secrets either.
       */
      force?: boolean
    }
  ): Promise<void> {
    const tags: Record<string, string> = { ...(args.tags ?? {}) }
    const provenance = args.provenance ?? 'declared'
    const contentHash = memoryFingerprint(args.content)

    // Trust boundary (Claude ZT / mem_5430): secrets + prompt-injection
    // refuse at SoT, not only at CLI/MCP. Silent drop matches captureGate.
    // requireWrite throws so user-facing verbs fail loud if a caller skipped
    // the edge check.
    {
      const evaluateMemoryContent = await import('../services/trust-boundary')
        .then((module) => module.evaluateMemoryContent)
        .catch(() => null)
      if (evaluateMemoryContent) {
        const trust = evaluateMemoryContent(args.content, { force: args.force })
        if (!trust.allow) {
          if (args.requireWrite) throw new Error(trust.denyMessage)
          return
        }
      }
    }

    // Precision classifier (pure, hard gate): empty specs, open-narration
    // gotchas, sub-substance inbox. Demote rewrites type before gate/dedup so
    // knowledge is preserved as context instead of polluting judgment types.
    // force (CLI/MCP) bypasses shape gates with an audit tag.
    const { classifyCapturePrecision } = await import('./precision-classifier')
    const precision = classifyCapturePrecision(args.content, args.type, {
      force: args.force === true,
    })
    if (precision.action === 'refuse') {
      if (args.requireWrite) {
        throw new Error(`precision refuse (${precision.reasonCode}): ${precision.reason}`)
      }
      return
    }
    if (precision.action === 'demote' && precision.demoteTo) {
      tags.shape_demoted = 'true'
      tags.original_type = args.type
      tags.precision_reason = precision.reasonCode
    }
    if (args.force) tags['precision:force'] = 'true'
    const type =
      precision.action === 'demote' && precision.demoteTo
        ? (precision.demoteTo as MemoryType)
        : args.type

    // Resolve the project once and reuse it for both the dedup guard and the
    // sync publish below (each used to read + parse the config independently).
    const projectId =
      args.projectId ??
      (await (async () => {
        try {
          const { default: configManager } = await import('../infrastructure/config-manager')
          return (await configManager.readConfig(projectPath))?.projectId
        } catch {
          return undefined
        }
      })())

    // Anticipation bind: if the agent omitted `file:`, infer a repo-relative
    // path from content / files tag / cycle scope so guard + work risks fire.
    // Explicit tags.file always wins. Never blocks a capture on inference.
    if (!tags.file) {
      try {
        const { inferMemoryFileTag } = await import('./infer-memory-file')
        const cycleFiles = projectId
          ? await (async (): Promise<string[] | null> => {
              try {
                const { stateStorage } = await import('../storage/state-storage')
                const task = await stateStorage.getCurrentTask(projectId)
                // Work-scope paths stamped when present (likelyFiles on some hosts).
                const raw = (task as { likelyFiles?: Array<{ path?: string } | string> } | null)
                  ?.likelyFiles
                if (Array.isArray(raw)) {
                  return raw
                    .map((f) => (typeof f === 'string' ? f : f?.path))
                    .filter((p): p is string => typeof p === 'string' && p.length > 0)
                }
                return null
              } catch {
                return null
              }
            })()
          : null
        const inferred = inferMemoryFileTag({
          content: args.content,
          tags,
          projectPath,
          cycleFiles,
        })
        if (inferred) {
          tags.file = inferred
          tags.file_source = 'inferred'
        }
      } catch {
        /* inference is best-effort */
      }
    }

    // Dedup net: a verbatim re-capture of the same (type, content) adds no
    // knowledge — it only dilutes recall and burns slots in the fixed-size
    // injection budget. Skip it. This is the universal guard behind EVERY
    // capture path (manual `remember`, the friction / skill-miss detectors),
    // so a single detector re-firing each session can't spam the
    // store. Best-effort: any lookup failure falls through to a normal write —
    // a dedup miss is cheaper than a dropped capture.
    const dedupTopicKey = tags.topic ?? tags.key
    if (projectId) {
      try {
        const dup = prjctDb.get<{ id: string }>(
          projectId,
          'SELECT id FROM memory_entries WHERE content_hash = ? AND type = ? AND deleted_at IS NULL LIMIT 1',
          contentHash,
          type
        )
        if (dup) {
          // Same content re-captured WITH a topic tag: don't create a row, but
          // DO fold the topic identity into the existing entry and supersede
          // the topic's other revisions — otherwise "adopt this entry into
          // topic X" is a silent no-op and stale revisions keep burning
          // recall slots (the exact failure the write-side upsert prevents).
          if (dedupTopicKey) {
            this.applyTopicSupersession(projectId, type, contentHash, dedupTopicKey)
          }
          return
        }
      } catch {
        /* fall through — never block a capture on the dedup check */
      }

      // Rho capture gate: low-excess noise (near-dup of reference model R) is
      // rejected for low-stakes types. Judgment types always pass. Best-effort
      // — never drop a capture because the gate failed to load.
      try {
        const { captureGate } = await import('../services/retention/capture-gate')
        const gate = captureGate(projectId, type, args.content, tags)
        if (!gate.accept) {
          // Demoted open-narration already retyped; if gate still refuses
          // (e.g. excess on context), drop silently unless requireWrite.
          if (args.requireWrite) {
            throw new Error(`capture refused: ${gate.reason}`)
          }
          return
        }
      } catch (err) {
        if (
          args.requireWrite &&
          err instanceof Error &&
          err.message.startsWith('capture refused')
        ) {
          throw err
        }
        /* gate unavailable — proceed with write */
      }
    }

    const logResult = await memoryService.log(
      projectPath,
      `${REMEMBER_ACTION_PREFIX}${type}`,
      {
        content: args.content,
        tags,
        source: args.source,
        provenance,
        // Carried so the memory_entries_from_events trigger writes the REAL
        // content fingerprint (for dedup) + project_id — not a synthetic value.
        content_hash: contentHash,
        ...(projectId ? { project_id: projectId } : {}),
      },
      undefined,
      // Explicit target: same value path-resolution yields for normal
      // captures; the global KB pseudo-project for --global ones.
      projectId || args.requireWrite
        ? { ...(projectId ? { projectId } : {}), required: args.requireWrite }
        : undefined
    )
    const resolvedProjectId = projectId ?? logResult?.projectId

    // memory_entries (the single source for recall + FTS) is populated by the
    // memory_entries_from_events trigger on the events insert above — covers
    // every writer uniformly. No `memories` mirror anymore.

    // Topic-key UPSERT semantics: a capture tagged `topic:` (or `key:`) is an
    // EVOLVING topic — the new entry supersedes prior versions instead of
    // accumulating alongside them. The event log stays append-only (audit +
    // sync intact); supersession is a store-level soft-delete of the older
    // active entries for the same (type, topic), and the new entry gets the
    // typed `topic_key` column + a revision_count lineage. GATED on the event
    // write actually succeeding (logResult.eventId): if `log()` swallowed a
    // transient failure, no new row exists — superseding the old revisions
    // then would silently erase the topic's only active knowledge.
    if (resolvedProjectId && dedupTopicKey && logResult?.eventId != null) {
      this.applyTopicSupersession(resolvedProjectId, type, contentHash, dedupTopicKey)
    }

    // Reinforcement loop: credit the entries this new one references — they
    // just proved load-bearing (the project is building on them). Feeds the
    // usefulness ranking so proven knowledge surfaces first over time.
    // Best-effort; dynamic import avoids a static service cycle.
    if (logResult?.projectId) {
      try {
        const { usefulnessService } = await import('../services/usefulness')
        usefulnessService.recordReferences(logResult.projectId, args.content, tags)
        // Negative half of the loop: an entry tagged corrects:/contradicts:
        // marks the referenced one as a mistake → demote it in recall.
        usefulnessService.recordCorrection(logResult.projectId, tags)
      } catch {
        /* never block a capture on reinforcement bookkeeping */
      }
    }

    // Phase 1.5 / B1: also publish to the sync queue so prjct-cloud
    // mirrors memories. memoryService.log writes to the local events
    // table, but it doesn't enqueue a SyncEvent for push — that's
    // what this call does. Best-effort; a sync queue write must not
    // fail the local memory write.
    if (!resolvedProjectId) return
    try {
      const { publishCRUD } = await import('../sync/publish-helper')
      const entityId =
        tags.spec_id ??
        tags.task_id ??
        tags.id ??
        args.source ??
        `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      await publishCRUD({
        projectId: resolvedProjectId,
        entityType: 'memories',
        entityId,
        eventType: 'upsert',
        data: {
          id: entityId,
          type,
          content: args.content,
          tags,
          source: args.source ?? null,
          provenance,
          // Origin authored time. We're creating the memory right now on
          // THIS machine, so now() IS the origin — receivers preserve it
          // verbatim instead of stamping their own ingestion clock.
          created_at: new Date().toISOString(),
          rememberedAt: new Date().toISOString(),
        },
      })
    } catch {
      // Best-effort — local memory write already succeeded.
    }
  },

  /**
   * FTS5 BM25 search over the `memories` table. Returns the top-N entries
   * ranked by relevance to the supplied keywords (with recency as the
   * tie-breaker). Best-effort: empty array on any failure (FTS unavailable,
   * malformed MATCH, etc.).
   *
   * The hook UserPromptSubmit calls this first for topical recall; if FTS
   * misses (empty index, no matches), the caller falls back to `recall()`.
   */
  searchFts(projectId: string, keywords: string[], limit: number): MemoryEntry[] {
    if (keywords.length === 0 || limit <= 0) return []
    // Sanitize: deburr first (FTS5 unicode61 indexes with
    // remove_diacritics, so "búsqueda" must query as "busqueda"), then
    // keep only token-friendly chars and drop FTS5-reserved operators so
    // a user prompt with literal "OR"/"AND"/"NEAR" doesn't hijack the
    // MATCH parse. Trailing-* allows prefix matching.
    const sanitized = keywords
      .map((kw) => deburr(kw).replace(/[^a-z0-9-]/gi, ''))
      .filter((kw) => kw.length >= 2)
    if (sanitized.length === 0) return []
    const matchExpr = sanitized.map((kw) => `"${kw}"*`).join(' OR ')

    type FtsRow = {
      id: string
      content: string
      type: string | null
      provenance: string | null
      created_at: number
    }
    const rows = (() => {
      try {
        // Overfetch: superseded pruning below may drop rows, and this is
        // the surface that feeds the per-prompt trap cue — a stale decision
        // must not consume the only result slot. Single-source: FTS over
        // memory_entries (migration 42).
        return prjctDb.query<FtsRow>(
          projectId,
          `SELECT m.id, m.content, m.type, m.provenance, m.created_at
         FROM memory_entries_fts ft
         JOIN memory_entries m ON m.rowid = ft.rowid
         WHERE memory_entries_fts MATCH ?
           AND m.deleted_at IS NULL
         ORDER BY bm25(memory_entries_fts) ASC, m.created_at DESC
         LIMIT ?`,
          matchExpr,
          limit * 2
        )
      } catch {
        return []
      }
    })()
    if (rows.length === 0) return []

    const tagsById = batchTagsByEntryId(
      projectId,
      rows.map((r) => r.id)
    )

    const entries = rows.map((row) => ({
      id: row.id,
      type: (row.type ?? 'fact') as MemoryType,
      content: row.content,
      tags: tagsById.get(row.id) ?? {},
      rememberedAt: new Date(row.created_at).toISOString(),
      provenance: (row.provenance ?? 'declared') as MemoryProvenance,
    }))

    // Author-declared compaction, same contract as recall(): a superseded
    // or duplicated entry must not surface as live advice. Unlike recall's
    // window-scoped prune, BM25 ordering rarely returns the SUPERSEDING
    // entry alongside the stale one, so the dead-id set comes from a scan
    // of all live mirror rows carrying relationship tags (small, indexed
    // by the LIKE pre-filter) instead of just the result window.
    const dead = collectMirrorSupersededIds(projectId)
    const liveEntries = dead.size > 0 ? entries.filter((entry) => !dead.has(entry.id)) : entries
    return liveEntries.slice(0, limit)
  },

  /**
   * Fetch matching entries across memory sources, newest-first.
   * Returns an empty array on failure — callers treat recall as best-effort.
   */
  recall(projectId: string, opts: RecallOpts = {}): MemoryEntry[] {
    const limit = opts.limit ?? DEFAULT_RECALL_LIMIT
    // We over-fetch from each source so in-memory filters (topic/tags/types)
    // still have headroom to return `limit` results. 4× is a heuristic:
    // enough for the common "filter by one type" case, cheap enough
    // otherwise.
    const overfetch = Math.max(limit * OVERFETCH_FACTOR, MIN_OVERFETCH)

    // Memory entries live in two tables: `events` (user-captured via
    // remember/capture) and `shipped_features` (auto-recorded ships).
    // When the caller filtered by `types`, we can skip whichever source
    // can never satisfy the filter — saves a query per recall.
    const typesFilter = opts.types && opts.types.length > 0 ? new Set(opts.types) : null
    const wantShipped = typesFilter ? typesFilter.has('shipped') : true
    const wantEvents = typesFilter ? [...typesFilter].some((t) => t !== 'shipped') : true

    // C1 read flip: authored memory comes from the normalized v2 tables
    // (memory_entries + memory_entry_tags), kept complete for every writer by
    // the memory_entries_from_events trigger. Typed columns + indexed tags —
    // no per-row JSON.parse of events.data on this per-prompt path. The type
    // predicate is pushed into SQL (not just the JS filter below) so the
    // per-prompt hot path gets an indexed SEARCH instead of a full SCAN.
    const sqlTypes = typesFilter
      ? [...typesFilter].filter((t): t is MemoryType => t !== 'shipped')
      : undefined
    const v2entries = wantEvents ? recallEntriesFromV2(projectId, overfetch, sqlTypes) : []
    const shipped = wantShipped
      ? prjctDb.query<ShippedRow>(
          projectId,
          'SELECT id, name, type, shipped_at, data FROM shipped_features ORDER BY shipped_at DESC LIMIT ?',
          overfetch
        )
      : []

    const allEntries: MemoryEntry[] = [...v2entries, ...shipped.map(shippedRowToEntry)]
    const typedEntries = typesFilter
      ? allEntries.filter((entry) => typesFilter.has(entry.type))
      : allEntries
    const taggedEntries = opts.tags
      ? typedEntries.filter((entry) => matchesTags(entry, opts.tags ?? {}))
      : typedEntries
    const topicalEntries = opts.topic
      ? taggedEntries.filter((entry) => matchesTopic(entry, opts.topic!))
      : taggedEntries
    const sortedEntries = [...topicalEntries].sort((a, b) =>
      b.rememberedAt.localeCompare(a.rememberedAt)
    )

    // Latest-winner dedupe: when an entry has a `key` tag, only the
    // newest entry per (type, key) survives. Entries without a key fall
    // through unchanged. Sort-then-dedupe order matters — must run AFTER
    // sort so the first match per group is the newest.
    const dedupedEntries =
      opts.dedupeByKey !== false ? dedupeLatestByKey(sortedEntries) : sortedEntries

    // Author-declared compaction: drop entries explicitly retired via
    // supersedes / superseded-by / duplicates. Runs before the slice so a
    // retired entry never consumes a result slot. Opt out (link/index layer)
    // to keep retired entries resolvable.
    const liveEntries = (() => {
      if (opts.pruneSuperseded === false) return dedupedEntries
      const dead = collectSupersededIds(dedupedEntries)
      return dead.size > 0 ? dedupedEntries.filter((entry) => !dead.has(entry.id)) : dedupedEntries
    })()

    return liveEntries.slice(0, limit)
  },

  /**
   * Anticipation lookup (RAG north star, pillar 3): the PREVENTIVE memories
   * recorded against a specific file — gotchas, anti-patterns, recurring-bug
   * patterns. Pulled on demand before editing — via `prjct guard <file>` or
   * the `prjct_guard` MCP tool — so the trap is seen before it's stepped in.
   *
   * Deliberately strict: only the "you'll break something" types, so the
   * result is empty for most files and never becomes noise. Plain decisions /
   * learnings about the file are NOT included here.
   *
   * Matches the stored `file` tag (repo-relative) against the edited path by
   * exact / suffix / basename so an absolute path from the editor still hits.
   */
  recallForFile(
    projectId: string,
    filePath: string,
    limit = 3,
    opts: { preventiveOnly?: boolean } = {}
  ): MemoryEntry[] {
    if (!filePath) return []
    const base = filePath.split('/').pop() ?? filePath
    const isPreventive = (e: MemoryEntry) =>
      e.type === 'gotcha' ||
      e.type === 'red-herring' ||
      e.type === 'anti-pattern' ||
      e.tags?.pattern === 'recurring-bug'
    // The `file_tag` generated column (migration 27) + partial index narrow
    // the scan to file-tagged remember rows in SQL — exact / suffix / basename
    // matching mirrors the original JS filter. Preventive-type filtering and
    // superseded pruning stay in JS over the (small) matched set.
    // memory_entries.file is the typed, indexed equivalent of the old events
    // `file_tag` generated column — exact / suffix / basename match in SQL.
    // SQL LIMIT bounds the hot path (pre-edit / guard). Over-fetch a small
    // multiple so preventive JS filter + superseded prune still fill `limit`.
    const sqlLimit = Math.max(limit * 5, 15)
    const preventiveMatches = (() => {
      try {
        return loadV2Entries(
          projectId,
          `AND file IS NOT NULL
            AND (file = ? OR ? LIKE '%/' || file OR file = ? OR file LIKE '%/' || ?)
            ORDER BY created_at DESC, rowid DESC
            LIMIT ?`,
          filePath,
          filePath,
          base,
          base,
          sqlLimit
        ).filter(isPreventive)
      } catch {
        return []
      }
    })()
    // Also surface the task CONTEXT that touched this file ("this file was
    // changed during these tasks, by these authors") — the git-anchored
    // second-brain answer to "what happened here / who?" without git blame.
    // Context entries carry a comma-joined `files` tag, so match in JS.
    // The pre-edit PUSH opts out (`preventiveOnly`): a heads-up that fires on
    // every edit must carry only TRAPS, not file history — history stays one
    // pull away via `prjct guard` when the agent actually asks "what happened?".
    const contextMatches = !opts.preventiveOnly
      ? (() => {
          try {
            const ctxRows = loadV2Entries(
              projectId,
              'AND type = ? ORDER BY created_at DESC, rowid DESC LIMIT 200',
              'context'
            )
            return ctxRows.filter((entry) => {
              const files = (entry.tags?.files ?? '').split(',').map((file) => file.trim())
              return files.some(
                (file) => file === filePath || file === base || file.endsWith(`/${base}`)
              )
            })
          } catch {
            return []
          }
        })()
      : []
    const matches = [...preventiveMatches, ...contextMatches]
    const dead = collectSupersededIds(matches)
    const liveMatches = dead.size > 0 ? matches.filter((entry) => !dead.has(entry.id)) : matches
    return liveMatches.slice(0, limit)
  },

  /**
   * Resolve a single memory entry by its `mem_<rowid>` id (or a bare
   * numeric id). This is the legibility fix: every `mem_NNNN` reference
   * the topical-memory injection / a memory body cites (`relates=mem_X`,
   * `resolves=mem_Y`) is otherwise an opaque dangling pointer that
   * neither a human (in Obsidian) nor an LLM can resolve. Returns null
   * if the id doesn't exist or isn't a remember-event row.
   */
  getById(projectId: string, id: string): MemoryEntry | null {
    const m = String(id)
      .trim()
      .match(/^(?:mem[_-])?(\d+)$/i)
    if (!m) return null
    try {
      return loadV2Entries(projectId, 'AND id = ?', `mem_${m[1]}`)[0] ?? null
    } catch {
      return null
    }
  },

  /**
   * Count remembered entries of ONE exact type, straight from the event store
   * (the same source recall reads). A targeted COUNT — no `LIKE` overfetch, no
   * JSON parse, no JS type-filter — for the hot prompt-hook path that only
   * needs a number (e.g. inbox depth). Exact-match equality uses the
   * `(type, …)` index, and it's not capped, so it can't undercount past a
   * fixed limit the way the old `recall({types}).length` did.
   */
  countByType(projectId: string, type: string): number {
    try {
      // project_id predicate lets SQLite SEARCH ix_mem_recall(project_id,
      // type, ...) instead of scanning the whole index — this runs per prompt.
      // 'local' is the trigger's fallback stamp for legacy/id-less events in
      // this same per-project DB; excluding it would silently uncount them.
      const row = prjctDb.get<{ n: number }>(
        projectId,
        "SELECT COUNT(*) AS n FROM memory_entries WHERE project_id IN (?, 'local') AND type = ? AND deleted_at IS NULL",
        projectId,
        type
      )
      return row?.n ?? 0
    } catch {
      return 0
    }
  },

  /**
   * Recall entries of ONE exact type, newest-first, WITHOUT the broad
   * `type LIKE 'memory.remember.%'` overfetch (4×) + JS type-filter that
   * `recall` does. For hot paths that need a single type's recent entries
   * (e.g. the improvement-signal block on every prompt). Skips supersede/dedup
   * — fine for keyless, non-superseded types like `improvement-signal`.
   */
  recallByType(projectId: string, type: string, limit: number): MemoryEntry[] {
    if (limit <= 0) return []
    try {
      return loadV2Entries(
        projectId,
        'AND type = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
        type,
        limit
      )
    } catch {
      return []
    }
  },

  /**
   * Forget a memory entry by id across EVERY read path, so it stops surfacing:
   *   - `events` row deleted — recall() + allEntriesForIndex read events directly
   *     (events has no deleted_at; the dedup migration likewise hard-deletes).
   *   - `memories` mirror soft-deleted (deleted_at) — searchFts filters on it.
   *   - any stored embedding dropped — so it can't resurface via semantic search.
   * Returns true iff a remember-event row existed and was removed. Best-effort
   * on the mirror/embedding cleanups (their absence must not fail the forget).
   */
  forget(projectId: string, id: string): boolean {
    const m = String(id)
      .trim()
      .match(/^(?:mem[_-])?(\d+)$/i)
    if (!m) return false
    const rowId = Number(m[1])
    const memId = `mem_${rowId}`
    // Source event (recall + vault index read events directly). A memories
    // mirror row can outlive its event and vice-versa, so clean each
    // independently and report success if EITHER surface had the entry.
    const eventRemoved = (() => {
      try {
        const event = prjctDb.get<{ id: number }>(
          projectId,
          'SELECT id FROM events WHERE id = ? AND type LIKE ?',
          rowId,
          `${REMEMBER_EVENT_PREFIX}%`
        )
        if (!event) return false
        prjctDb.run(projectId, 'DELETE FROM events WHERE id = ?', rowId)
        return true
      } catch {
        return false
      }
    })()

    // (memory_entries soft-delete below is the single-source forget; it also
    // removes the entry from searchFts via the FTS triggers.)

    // Drop any stored embedding so it can't resurface via semantic search.
    try {
      prjctDb.run(projectId, 'DELETE FROM memory_embeddings WHERE memory_id = ?', memId)
    } catch {}

    // Schema v2 single source: soft-delete the normalized row so recall +
    // searchFts (which read memory_entries) stop returning it. Counts as a
    // successful forget even if the events/legacy mirrors had nothing.
    const entryRemoved = (() => {
      try {
        const result = prjctDb.run(
          projectId,
          'UPDATE memory_entries SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL',
          Date.now(),
          memId
        )
        return result.changes > 0
      } catch {
        return false
      }
    })()

    return eventRemoved || entryRemoved
  },

  /**
   * Follow each seed entry's cross-references ONE hop and return the linked
   * entries (deduped against the seed, capped).
   *
   * The relationship graph already exists as text — a decision captured with
   * `--tags resolves:mem_2609` (or an inline `mem_2609` mention) renders as a
   * wikilink in the vault — but no RETRIEVAL path ever traversed it. So
   * recalling "the decision that resolved X" left X itself (the superseded
   * decision, the bug it fixed, the spec it implements) invisible to the
   * agent unless it manually looked it up. This surfaces those one hop out so
   * a single recall carries its own context. Bounded by `cap` so a densely
   * linked entry can't balloon the injected context.
   */
  expandWithLinks(projectId: string, seed: MemoryEntry[], cap = 5): MemoryEntry[] {
    if (seed.length === 0 || cap <= 0) return []
    const refRe = /\bmem[_-](\d+)\b/g
    // Tag keys whose values name a related entry. Kept explicit (not "any
    // tag") so an arbitrary `mem_N`-looking tag value can't pull noise.
    const relKeys = ['resolves', 'relates', 'supersedes', 'superseded-by', 'duplicates', 'spec']
    const seen = new Set(seed.map((e) => e.id))
    const linked: MemoryEntry[] = []

    for (const entry of seed) {
      if (linked.length >= cap) break
      const refs = new Set<string>()
      for (const key of relKeys) {
        const v = entry.tags?.[key]
        if (!v) continue
        for (const m of String(v).matchAll(refRe)) refs.add(`mem_${m[1]}`)
      }
      for (const m2 of entry.content.matchAll(refRe)) refs.add(`mem_${m2[1]}`)

      for (const ref of refs) {
        if (linked.length >= cap) break
        if (seen.has(ref)) continue
        seen.add(ref)
        const e = projectMemory.getById(projectId, ref)
        if (e) linked.push(e)
      }
    }
    return linked
  },

  /**
   * EVERY entry — no limit, no topic/type filter, no latest-winner
   * dedupe. The vault link layer needs this: `recall()` collapses
   * `(type, key)` duplicates and caps results, so an older entry that
   * a current one still references (`resolves=mem_2609`) vanishes from
   * the index and its links rot to a dangling `[[mem_2609]]`. Building
   * the `mem_N → {type,title}` index from the full set is what keeps
   * every cross-reference resolvable (the mem_3233 dangling class, at
   * graph scale). Read-only, best-effort.
   */
  /**
   * Entries that still LACK a vector for `model` — the embedding-backfill
   * work list, via SQL anti-join instead of deserializing the whole corpus
   * and set-diffing in JS. The improvement-signal / hot-file exclusions
   * mirror `isModelMemory` as SQL pre-filters; callers still apply
   * `isModelMemory` over the (small) result for authority.
   */
  unembeddedEntriesForIndex(projectId: string, model: string): MemoryEntry[] {
    try {
      const rows = loadV2Entries(
        projectId,
        `AND type != ?
          AND NOT EXISTS (
            SELECT 1 FROM memory_embeddings me
             WHERE me.memory_id = memory_entries.id AND me.model = ?
          )
          ORDER BY created_at DESC, rowid DESC`,
        'improvement-signal',
        model
      )
      const shipped = prjctDb.query<ShippedRow>(
        projectId,
        `SELECT s.id, s.name, s.type, s.shipped_at, s.data FROM shipped_features s
          WHERE NOT EXISTS (
            SELECT 1 FROM memory_embeddings me
             WHERE me.memory_id = 'ship_' || s.id AND me.model = ?
          )
          ORDER BY s.shipped_at DESC`,
        model
      )
      return [...rows, ...shipped.map(shippedRowToEntry)]
    } catch {
      return []
    }
  },

  allEntriesForIndex(projectId: string): MemoryEntry[] {
    try {
      const stamp = memoryVaultStamp(projectId)
      const hit = vaultSnapshots.get(projectId)
      // Shallow copy: callers may sort/filter the array in place; the shared
      // snapshot itself must stay immutable.
      if (hit && hit.stamp === stamp) return [...hit.entries]
      const entries = loadV2Entries(projectId, 'ORDER BY created_at DESC, rowid DESC')
      const shipped = prjctDb.query<ShippedRow>(
        projectId,
        'SELECT id, name, type, shipped_at, data FROM shipped_features ORDER BY shipped_at DESC'
      )
      const all = [...entries, ...shipped.map(shippedRowToEntry)]
      vaultSnapshots.set(projectId, { stamp, entries: all })
      return [...all]
    } catch {
      return []
    }
  },
}
