/**
 * Memory reinforcement ledger — "prjct gets smarter the more it's used."
 *
 * Recall already ranks by relevance (BM25 / semantic) and recency. What it
 * lacked was a memory of WHICH knowledge actually pays off. This service
 * accumulates a per-entry `usefulness` score from deterministic usage
 * signals and feeds it back into the ranking:
 *
 *   - reference  — a newly captured entry cites an older `mem_N`
 *                  (resolves / relates / supersedes / inline mention). The
 *                  cited entry is load-bearing knowledge the project keeps
 *                  building on → strong positive signal.
 *   - fetch      — an entry was pulled by id on purpose
 *                  (`prjct context memory mem_N`) → weaker positive signal.
 *
 * Scores TIME-DECAY (half-life): knowledge that stops being used fades from
 * the ranking boost on its own, so the system tracks what is useful NOW, not
 * what was useful once. That decay is how it "learns from" disuse — the
 * negative half of the loop — without ever deleting anything.
 *
 * Best-effort throughout: a failure here must never break a capture or a
 * recall. Time is injectable so tests are deterministic.
 */

import type { MemoryEntry } from '../../memory/entries'
import prjctDb from '../../storage/database'

/** Days for a usefulness contribution to halve. ~6 weeks: a decision cited
 *  last month still counts, one cited last year barely does. */
const HALF_LIFE_DAYS = 45
const REF_WEIGHT = 1.0
const FETCH_WEIGHT = 0.4
/** Strongest signal: this entry was surfaced during work that actually
 *  shipped. A real outcome, not just a citation. */
const SHIP_WEIGHT = 2.5
/** Negative signal: a later entry declared this one WRONG (`corrects:` /
 *  `contradicts:`). The project learned this knowledge was a mistake, so it
 *  sinks in recall — but is never deleted (the record + the correction's
 *  context stay resolvable). Magnitude mirrors a ship credit, inverted. */
const CORRECTION_WEIGHT = -2.5
/** AUTOMATIC negative: the user pushed back (friction) while these memories
 *  were in context. Smaller than an explicit correction — attribution is
 *  fuzzy (the friction may be unrelated) — but it needs NO command, so prjct
 *  learns from mistakes on its own. Bounded by decay + the rerank cap. */
const FRICTION_WEIGHT = -0.5
/** AUTOMATIC negative: a skill-miss signal flagged this entry as relevant
 *  but unused. The signal's `relates:` tag already earned it an automatic
 *  REF_WEIGHT credit inside `remember()` — but a miss is not load-bearing
 *  usage, so this cancels that (+1.0) and nets a small −0.3: knowledge that
 *  keeps failing to land sinks slightly instead of climbing. The session
 *  digest separately surfaces repeat-missed entries so they get reworded or
 *  applied rather than just buried. */
const SKILL_MISS_WEIGHT = -1.3
const MS_PER_DAY = 86_400_000

/** Tag keys whose values name a related entry (mirrors expandWithLinks). */
const REL_KEYS = ['resolves', 'relates', 'supersedes', 'superseded-by', 'duplicates', 'spec']
/** Tag keys that mark the referenced entry as an ERROR. Tags ONLY (never
 *  inline content) so a passing `mem_N` mention can't accidentally demote. */
const CORRECTION_KEYS = ['corrects', 'contradicts']
const MEM_REF_RE = /\bmem[_-](\d+)\b/g

/** Collect the `mem_N` ids a new entry points at (relationship tags + inline). */
export function extractRefIds(content: string, tags: Record<string, string>): string[] {
  const ids = new Set<string>()
  for (const key of REL_KEYS) {
    const v = tags[key]
    if (!v) continue
    for (const m of String(v).matchAll(MEM_REF_RE)) ids.add(`mem_${m[1]}`)
  }
  for (const m2 of content.matchAll(MEM_REF_RE)) ids.add(`mem_${m2[1]}`)
  // A correction naturally NAMES the entry it corrects (inline or in the
  // tag), which would otherwise credit a positive reference that cancels the
  // penalty. An entry you're marking WRONG must not also be rewarded — drop
  // any id this same entry corrects/contradicts from the positive set.
  for (const cid of extractCorrectionIds(tags)) ids.delete(cid)
  return [...ids]
}

/** Collect the `mem_N` ids a new entry marks as WRONG (correction tags only). */
export function extractCorrectionIds(tags: Record<string, string>): string[] {
  const ids = new Set<string>()
  for (const key of CORRECTION_KEYS) {
    const v = tags[key]
    if (!v) continue
    for (const m of String(v).matchAll(MEM_REF_RE)) ids.add(`mem_${m[1]}`)
  }
  return [...ids]
}

interface UsefulnessRow {
  memory_id: string
  score: number
  last_used_at: string
}

interface SurfaceRow {
  memory_id: string
  query_text: string | null
  surface: string | null
}

export interface SurfaceOptions {
  /** User/search query that caused this memory to surface. Stored as data, not instructions. */
  queryText?: string
  /** Retrieval surface, e.g. context-memory, guard, prompt-cue. */
  surface?: string
}

function bump(
  projectId: string,
  memoryId: string,
  weight: number,
  column: 'ref_count' | 'fetch_count',
  nowIso: string
): void {
  prjctDb.run(
    projectId,
    `INSERT INTO memory_usefulness (memory_id, score, ${column}, last_used_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(memory_id) DO UPDATE SET
       score = score + ?, ${column} = ${column} + 1, last_used_at = excluded.last_used_at`,
    memoryId,
    weight,
    nowIso,
    weight
  )
}

/** Adjust only the score (no count column) by `delta`, which may be negative. */
function addScore(projectId: string, memoryId: string, delta: number, nowIso: string): void {
  prjctDb.run(
    projectId,
    `INSERT INTO memory_usefulness (memory_id, score, last_used_at)
     VALUES (?, ?, ?)
     ON CONFLICT(memory_id) DO UPDATE SET
       score = score + ?, last_used_at = excluded.last_used_at`,
    memoryId,
    delta,
    nowIso,
    delta
  )
}

export const usefulnessService = {
  /** Credit every entry that `content`/`tags` reference (a capture happened). */
  recordReferences(
    projectId: string,
    content: string,
    tags: Record<string, string>,
    nowIso: string = new Date().toISOString()
  ): void {
    try {
      for (const id of extractRefIds(content, tags)) {
        bump(projectId, id, REF_WEIGHT, 'ref_count', nowIso)
      }
    } catch {
      /* best-effort — never block a capture */
    }
  },

  /**
   * Penalize entries a new capture marks WRONG via `corrects:` / `contradicts:`
   * tags — the negative half of the loop. Demotes them in recall without
   * deleting them. Best-effort.
   */
  recordCorrection(
    projectId: string,
    tags: Record<string, string>,
    nowIso: string = new Date().toISOString()
  ): void {
    try {
      for (const id of extractCorrectionIds(tags)) {
        addScore(projectId, id, CORRECTION_WEIGHT, nowIso)
      }
    } catch {
      /* best-effort — never block a capture */
    }
  },

  /** Credit an entry pulled deliberately by id. */
  recordFetch(
    projectId: string,
    memoryId: string,
    nowIso: string = new Date().toISOString()
  ): void {
    try {
      bump(projectId, memoryId, FETCH_WEIGHT, 'fetch_count', nowIso)
    } catch {
      /* best-effort */
    }
  },

  /**
   * Note that `memoryIds` were surfaced during `taskId`. Kept in a transient
   * log; credited (or dropped) when the task ships (or is abandoned). At most
   * one row per (memory, task).
   */
  recordSurfaced(
    projectId: string,
    memoryIds: string[],
    taskId: string,
    nowIso: string = new Date().toISOString(),
    opts: SurfaceOptions = {}
  ): void {
    if (!taskId || memoryIds.length === 0) return
    try {
      const queryText = opts.queryText?.trim() || null
      const surface = opts.surface?.trim() || null
      for (const id of memoryIds) {
        prjctDb.run(
          projectId,
          `INSERT INTO memory_surface_log (memory_id, task_id, created_at, query_text, surface)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(memory_id, task_id) DO UPDATE SET
             query_text = COALESCE(memory_surface_log.query_text, excluded.query_text),
             surface = COALESCE(memory_surface_log.surface, excluded.surface)`,
          id,
          taskId,
          nowIso,
          queryText,
          surface
        )
      }
    } catch {
      /* best-effort — surfacing telemetry must never break a recall */
    }
  },

  /**
   * AUTOMATIC negative reinforcement: the active task hit user friction this
   * session, so gently demote the entries surfaced during it. Unlike
   * `creditShippedTask`, this does NOT clear the surface rows — the task is
   * still in flight and may yet ship. Returns how many entries were nudged.
   * Best-effort. No command required — this is what makes prjct learn from
   * mistakes on its own.
   */
  penalizeSurfaced(
    projectId: string,
    taskId: string,
    nowIso: string = new Date().toISOString()
  ): number {
    if (!taskId) return 0
    try {
      const rows = prjctDb.query<{ memory_id: string }>(
        projectId,
        'SELECT memory_id FROM memory_surface_log WHERE task_id = ?',
        taskId
      )
      for (const r of rows) addScore(projectId, r.memory_id, FRICTION_WEIGHT, nowIso)
      return rows.length
    } catch {
      return 0
    }
  },

  /**
   * AUTOMATIC negative reinforcement for a skill-miss: `memoryId` was
   * relevant to a session's work but never referenced. Cancels the automatic
   * ref credit the miss-signal's `relates:` tag just earned it and nets a
   * small penalty (see SKILL_MISS_WEIGHT). Best-effort.
   */
  penalizeSkillMiss(
    projectId: string,
    memoryId: string,
    nowIso: string = new Date().toISOString()
  ): void {
    try {
      addScore(projectId, memoryId, SKILL_MISS_WEIGHT, nowIso)
    } catch {
      /* best-effort — never block the Stop hook */
    }
  },

  /**
   * A task shipped successfully: credit every entry surfaced during it with
   * the strong ship-success weight, then clear the task's surface rows.
   * Returns how many entries were credited. Best-effort.
   */
  creditShippedTask(
    projectId: string,
    taskId: string,
    nowIso: string = new Date().toISOString()
  ): number {
    if (!taskId) return 0
    try {
      const rows = prjctDb.query<SurfaceRow>(
        projectId,
        'SELECT memory_id, query_text, surface FROM memory_surface_log WHERE task_id = ?',
        taskId
      )
      for (const r of rows) {
        addScore(projectId, r.memory_id, SHIP_WEIGHT, nowIso)
        const queryText = r.query_text?.trim()
        if (queryText) {
          prjctDb.run(
            projectId,
            `INSERT OR IGNORE INTO retrieval_eval_labels
               (query_text, positive_id, source, source_task_id, created_at, metadata)
             VALUES (?, ?, ?, ?, ?, ?)`,
            queryText,
            r.memory_id,
            'ship-surfaced',
            taskId,
            nowIso,
            JSON.stringify({ surface: r.surface ?? 'unknown' })
          )
        }
      }
      prjctDb.run(projectId, 'DELETE FROM memory_surface_log WHERE task_id = ?', taskId)
      return rows.length
    } catch {
      return 0
    }
  },

  /**
   * Current time-decayed usefulness per memory id. A score recorded `age`
   * days ago is worth `score * 0.5^(age / HALF_LIFE_DAYS)` today.
   */
  /**
   * Time-decayed usefulness scores. When `ids` is provided (the common
   * FTS/rerank path), only those rows are loaded — full-table scans were
   * pure tax as vaults grew.
   */
  decayedScores(
    projectId: string,
    nowMs: number = Date.now(),
    ids?: readonly string[]
  ): Map<string, number> {
    const out = new Map<string, number>()
    const rows = (() => {
      try {
        if (ids && ids.length > 0) {
          const unique = [...new Set(ids)].slice(0, 200)
          const placeholders = unique.map(() => '?').join(',')
          return prjctDb.query<UsefulnessRow>(
            projectId,
            `SELECT memory_id, score, last_used_at FROM memory_usefulness WHERE memory_id IN (${placeholders})`,
            ...unique
          )
        } else if (ids && ids.length === 0) {
          return []
        } else {
          return prjctDb.query<UsefulnessRow>(
            projectId,
            'SELECT memory_id, score, last_used_at FROM memory_usefulness'
          )
        }
      } catch {
        return null
      }
    })()
    if (!rows) return out
    for (const r2 of rows) {
      const last = Date.parse(r2.last_used_at)
      const factor = Number.isNaN(last)
        ? 1
        : 0.5 ** (Math.max(0, nowMs - last) / MS_PER_DAY / HALF_LIFE_DAYS)
      out.set(r2.memory_id, r2.score * factor)
    }
    return out
  },

  /**
   * Re-rank a relevance-ordered list with a BOUNDED usefulness boost: a
   * proven-useful entry can climb a few slots, but relevance still leads
   * (the boost only reorders near-equals). Stable for entries with no score.
   * Returns a new array; never throws.
   */
  rerank(projectId: string, entries: MemoryEntry[], nowMs: number = Date.now()): MemoryEntry[] {
    if (entries.length < 2) return entries
    const scores = (() => {
      try {
        // Only load usefulness for candidates being reranked (not full table).
        return this.decayedScores(
          projectId,
          nowMs,
          entries.map((e) => e.id)
        )
      } catch {
        return null
      }
    })()
    if (!scores) return entries
    if (scores.size === 0) return entries

    const max = Math.max(1, ...scores.values())
    // Max slots a maximally-useful entry may climb. Small so relevance leads.
    const BOOST = 4
    const n = entries.length
    const ranked = entries.map((entry, i) => {
      const norm = (scores.get(entry.id) ?? 0) / max // 0..1
      // Higher rankScore = earlier. Relevance contributes (n - i); usefulness
      // adds up to BOOST. Index keeps the sort stable on ties.
      return { entry, i, rankScore: n - i + BOOST * norm }
    })
    ranked.sort((a, b) => b.rankScore - a.rankScore || a.i - b.i)
    return ranked.map((r) => r.entry)
  },
}
