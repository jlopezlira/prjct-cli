/**
 * Cold-store purge — make soft-delete and archives actually die.
 *
 * Soft-delete (deleted_at set) removes rows from recall but leaves them on
 * disk forever without this module. Archives accumulate every retention wave.
 * Both are purged on `prjct sync` (the maintenance pass).
 *
 * Deterministic, capped, best-effort. Never touches live (deleted_at IS NULL)
 * judgment without going through retention first.
 */

import type { MemoryEntry } from '../../memory/entries'
import { projectMemory } from '../../memory/project-memory'
import { archiveStorage } from '../../storage/archive-storage'
import prjctDb from '../../storage/database'

/** Soft-deleted rows have no future/statistical value — purge quickly. */
export const DEFAULT_SOFT_DELETED_PURGE_DAYS = 7
export const DEFAULT_ARCHIVE_PRUNE_DAYS = 90
export const DEFAULT_AUTO_SOURCE_MAX_LIVE = 20
/** Sources that are auto-generated (not human judgment). */
export const AUTO_SOURCE_PREFIXES = [
  'pattern-detector',
  'transcript-auto',
  'skill-miss',
  'friction',
  'land-auto',
  'sync-context-quality',
] as const

export interface PurgeResult {
  softDeletedPurged: number
  orphanEventsPurged: number
  archivesPruned: number
  autoSourceTrimmed: number
  /** Hard-deleted after distill (auto-source noise). */
  distilledDiscarded?: number
  digestsWritten?: number
}

export interface VaultHealth {
  live: number
  softDeleted: number
  archives: number
  rememberEvents: number
  autoSourceLive: number
}

function isAutoSource(source: string | undefined): boolean {
  if (!source) return false
  return AUTO_SOURCE_PREFIXES.some(
    (p) => source === p || source.startsWith(`${p}-`) || source.startsWith(p)
  )
}

/**
 * Hard-delete memory_entries rows soft-deleted more than `olderThanDays` ago.
 * Also drops their tags (CASCADE) and embeddings.
 */
export function purgeSoftDeleted(
  projectId: string,
  olderThanDays: number = DEFAULT_SOFT_DELETED_PURGE_DAYS,
  maxRows: number = 500
): number {
  const cutoff = Date.now() - olderThanDays * 86_400_000
  try {
    const rows = prjctDb.query<{ id: string }>(
      projectId,
      `SELECT id FROM memory_entries
       WHERE deleted_at IS NOT NULL AND deleted_at < ?
       ORDER BY deleted_at ASC
       LIMIT ?`,
      cutoff,
      maxRows
    )
    if (rows.length === 0) return 0

    prjctDb.transaction(projectId, (db) => {
      const delEmb = db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?')
      const delEntry = db.prepare('DELETE FROM memory_entries WHERE id = ?')
      for (const r of rows) {
        try {
          delEmb.run(r.id)
        } catch {
          /* embeddings table may be empty */
        }
        delEntry.run(r.id)
      }
    })
    return rows.length
  } catch {
    return 0
  }
}

/**
 * Delete remember-events whose memory_entries row is gone or soft-deleted
 * past cutoff (orphan audit rows that no longer map to live knowledge).
 */
export function purgeOrphanRememberEvents(
  projectId: string,
  olderThanDays: number = DEFAULT_SOFT_DELETED_PURGE_DAYS,
  maxRows: number = 500
): number {
  const cutoffIso = new Date(Date.now() - olderThanDays * 86_400_000).toISOString()
  try {
    // Events whose id has no live memory_entries mem_<id>.
    // Range predicate instead of LIKE: SQLite LIKE is case-insensitive by
    // default, which cannot use idx_events_type_ts (full scan + per-row
    // NOT EXISTS probe). `'.'` is 0x2E and `'/'` is 0x2F, so the range
    // covers exactly the 'memory.remember.' prefix under BINARY collation.
    const rows = prjctDb.query<{ id: number }>(
      projectId,
      `SELECT e.id FROM events e
       WHERE e.type >= 'memory.remember.' AND e.type < 'memory.remember/'
         AND e.timestamp < ?
         AND NOT EXISTS (
           SELECT 1 FROM memory_entries m
           WHERE m.id = 'mem_' || e.id AND m.deleted_at IS NULL
         )
       ORDER BY e.id ASC
       LIMIT ?`,
      cutoffIso,
      maxRows
    )
    if (rows.length === 0) return 0
    prjctDb.transaction(projectId, (db) => {
      const del = db.prepare('DELETE FROM events WHERE id = ?')
      for (const r of rows) del.run(r.id)
    })
    return rows.length
  } catch {
    return 0
  }
}

/**
 * If more than `maxLive` entries share an auto source, soft-delete the oldest
 * excess (FIFO). Keeps auto-noise from unbounded growth between syncs.
 */
export function trimAutoSourceCap(
  projectId: string,
  maxLive: number = DEFAULT_AUTO_SOURCE_MAX_LIVE
): number {
  if (maxLive <= 0) return 0
  const trimmed: MemoryEntry[] = []
  try {
    const entries = projectMemory.allEntriesForIndex(projectId)
    const bySource = new Map<string, MemoryEntry[]>()
    for (const e of entries) {
      const src = e.tags?.source
      if (!isAutoSource(src)) continue
      const key = src!
      const list = bySource.get(key) ?? []
      list.push(e)
      bySource.set(key, list)
    }
    for (const [, list] of bySource) {
      if (list.length <= maxLive) continue
      // Oldest first
      list.sort((a, b) => a.rememberedAt.localeCompare(b.rememberedAt))
      const overflow = list.slice(0, list.length - maxLive)
      for (const e2 of overflow) {
        try {
          archiveStorage.archive(projectId, {
            entityType: 'memory_entry',
            entityId: e2.id,
            entityData: {
              id: e2.id,
              type: e2.type,
              content: e2.content,
              tags: e2.tags,
              rememberedAt: e2.rememberedAt,
            },
            summary: e2.content.slice(0, 80),
            reason: `auto-source-cap (>${maxLive})`,
          })
        } catch {
          /* best-effort */
        }
        if (projectMemory.forget(projectId, e2.id)) trimmed.push(e2)
      }
    }
  } catch {
    return trimmed.length
  }
  return trimmed.length
}

/** Snapshot for sync --md vault health line. */
export function vaultHealth(projectId: string): VaultHealth {
  const live =
    prjctDb.get<{ c: number }>(
      projectId,
      'SELECT COUNT(*) AS c FROM memory_entries WHERE deleted_at IS NULL'
    )?.c ?? 0
  const softDeleted =
    prjctDb.get<{ c: number }>(
      projectId,
      'SELECT COUNT(*) AS c FROM memory_entries WHERE deleted_at IS NOT NULL'
    )?.c ?? 0
  const archives =
    prjctDb.get<{ c: number }>(projectId, 'SELECT COUNT(*) AS c FROM archives')?.c ?? 0
  const rememberEvents =
    prjctDb.get<{ c: number }>(
      projectId,
      // Range predicate (not LIKE): LIKE is case-insensitive in SQLite and
      // defeats idx_events_type_ts; '.'=0x2E and '/'=0x2F bound the prefix.
      "SELECT COUNT(*) AS c FROM events WHERE type >= 'memory.remember.' AND type < 'memory.remember/'"
    )?.c ?? 0

  const autoSourceLive = (() => {
    try {
      return projectMemory.allEntriesForIndex(projectId).filter((e) => isAutoSource(e.tags?.source))
        .length
    } catch {
      return 0
    }
  })()

  return { live, softDeleted, archives, rememberEvents, autoSourceLive }
}

/**
 * Full cold purge pass for sync. Best-effort; never throws.
 *
 * Policy (user): if rows have no future value — not even statistical —
 * distill a one-line residue when useful, then HARD-delete. No purgatory.
 */
export async function runVaultPurge(
  projectId: string,
  opts: {
    projectPath?: string
    softDeletedPurgeDays?: number
    archivePruneDays?: number
    autoSourceMaxLive?: number
    dryRun?: boolean
  } = {}
): Promise<PurgeResult> {
  const softDays = opts.softDeletedPurgeDays ?? DEFAULT_SOFT_DELETED_PURGE_DAYS
  const archDays = opts.archivePruneDays ?? DEFAULT_ARCHIVE_PRUNE_DAYS
  const autoMax = opts.autoSourceMaxLive ?? DEFAULT_AUTO_SOURCE_MAX_LIVE
  const dryRun = opts.dryRun === true

  if (dryRun) {
    return {
      softDeletedPurged: 0,
      orphanEventsPurged: 0,
      archivesPruned: 0,
      autoSourceTrimmed: 0,
      distilledDiscarded: 0,
      digestsWritten: 0,
    }
  }

  const distillation = await (async () => {
    // Distill-then-hard-delete auto-source overflow (preferred over soft-delete).
    if (opts.projectPath) {
      try {
        const { distillAndDiscardAllAutoSources } = await import('./distill')
        const d = await distillAndDiscardAllAutoSources(opts.projectPath, projectId, autoMax)
        return { distilledDiscarded: d.discarded, digestsWritten: d.digests }
      } catch {
        // Fallback: soft-trim if distill fails
        trimAutoSourceCap(projectId, autoMax)
        return { distilledDiscarded: 0, digestsWritten: 0 }
      }
    } else {
      trimAutoSourceCap(projectId, autoMax)
      return { distilledDiscarded: 0, digestsWritten: 0 }
    }
  })()
  const { distilledDiscarded, digestsWritten } = distillation

  // Soft-deleted = already judged worthless → hard eliminate (no second archive).
  const { eliminateSoftDeletedNoValue } = await import('./distill')
  const elim = eliminateSoftDeletedNoValue(projectId, softDays)
  const softDeletedPurged = elim.purged || purgeSoftDeleted(projectId, softDays)

  const orphanEventsPurged = purgeOrphanRememberEvents(projectId, softDays)
  const archivesPruned = (() => {
    try {
      return archiveStorage.pruneOldArchives(projectId, archDays)
    } catch {
      return 0
    }
  })()

  return {
    softDeletedPurged,
    orphanEventsPurged,
    archivesPruned,
    autoSourceTrimmed: distilledDiscarded,
    distilledDiscarded,
    digestsWritten,
  }
}

export { isAutoSource }
