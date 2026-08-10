/**
 * Sync Pending Storage — durable, concurrency-safe queue of SyncEvents
 * waiting to be pushed to prjct-cloud (Phase 1.5 / B3).
 *
 * Replaces `~/.prjct-cli/projects/<id>/sync/pending.json`. The JSON
 * file was racy: a CLI write and a WS-applied event landing at the
 * same instant could clobber one another. Migration to SQLite gives
 * us:
 *   - atomic INSERT (the WAL journal serializes writers)
 *   - atomic DELETE-by-id batches via `clearProcessed()` so a partial
 *     server response doesn't drop unconfirmed events
 *   - dedupe-by-(entity_type, entity_id) so resending the same logical
 *     update doesn't push two events
 *
 * Same shape as `core/storage/spec-storage.ts` — thin domain methods
 * over `prjctDb.run/query/get`.
 */

import type { SyncEvent } from '../types/events'
import { getTimestamp } from '../utils/date-helper'
import prjctDb from './database'

interface SyncPendingRow {
  id: number
  project_id: string
  entity_type: string | null
  entity_id: string | null
  event_type: string | null
  content_hash: string | null
  payload: string
  enqueued_at: string
}

export interface PendingEntry {
  /** Local autoincrement id — used by `clearProcessed` to remove confirmed batches. */
  id: number
  event: SyncEvent
  enqueuedAt: string
}

class SyncPendingStorage {
  /**
   * Append an event to the pending queue. Idempotent on
   * (entity_type, entity_id, content_hash): re-publishing the same
   * logical update collapses to ONE row (the latest one). This keeps
   * the queue from blowing up if a storage emits duplicate events
   * during retries.
   */
  append(projectId: string, event: SyncEvent): PendingEntry {
    const enqueuedAt = getTimestamp()
    const payload = JSON.stringify(event)

    // Dedupe: drop any earlier pending row for the same
    // (entity_type, entity_id, content_hash) tuple. The latest event
    // supersedes — for unhashed legacy events we leave the older row
    // alone (no idempotency signal to compare against).
    if (event.entityType && event.entityId && event.contentHash) {
      prjctDb.run(
        projectId,
        `DELETE FROM sync_pending
         WHERE project_id = ?
           AND entity_type = ?
           AND entity_id = ?
           AND content_hash = ?`,
        projectId,
        event.entityType,
        event.entityId,
        event.contentHash
      )
    }

    prjctDb.run(
      projectId,
      `INSERT INTO sync_pending
        (project_id, entity_type, entity_id, event_type, content_hash, payload, enqueued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      projectId,
      event.entityType ?? null,
      event.entityId ?? null,
      event.eventType ?? null,
      event.contentHash ?? null,
      payload,
      enqueuedAt
    )

    const row = prjctDb.get<{ id: number }>(projectId, 'SELECT last_insert_rowid() AS id')
    return {
      id: row?.id ?? 0,
      event,
      enqueuedAt,
    }
  }

  /**
   * Read all pending entries, oldest-first (FIFO push order). The
   * caller (sync-manager) is responsible for clearing them after the
   * server confirms.
   */
  list(projectId: string, limit?: number): PendingEntry[] {
    const sql = limit
      ? 'SELECT * FROM sync_pending WHERE project_id = ? ORDER BY id ASC LIMIT ?'
      : 'SELECT * FROM sync_pending WHERE project_id = ? ORDER BY id ASC'
    const rows = limit
      ? prjctDb.query<SyncPendingRow>(projectId, sql, projectId, limit)
      : prjctDb.query<SyncPendingRow>(projectId, sql, projectId)
    return rows.map((r) => this.rowToEntry(r))
  }

  count(projectId: string): number {
    const row = prjctDb.get<{ n: number }>(
      projectId,
      'SELECT COUNT(*) AS n FROM sync_pending WHERE project_id = ?',
      projectId
    )
    return row?.n ?? 0
  }

  /**
   * Remove all rows up to and including `lastId`. Use AFTER the server
   * confirms the batch was processed. Atomic — partial deletes can't
   * leave the queue in an inconsistent state.
   */
  clearUpTo(projectId: string, lastId: number): number {
    if (lastId <= 0) return 0
    const before = this.count(projectId)
    prjctDb.run(
      projectId,
      'DELETE FROM sync_pending WHERE project_id = ? AND id <= ?',
      projectId,
      lastId
    )
    return before - this.count(projectId)
  }

  /**
   * Hard reset of the queue for this project. Used by tests + after a
   * full re-sync where the server re-acks everything.
   */
  clearAll(projectId: string): void {
    prjctDb.run(projectId, 'DELETE FROM sync_pending WHERE project_id = ?', projectId)
  }

  /**
   * Remove specific rows by id (sparse confirms). Idempotent — missing
   * ids are silently ignored.
   */
  clearByIds(projectId: string, ids: number[]): void {
    if (ids.length === 0) return
    const placeholders = ids.map(() => '?').join(',')
    prjctDb.run(
      projectId,
      `DELETE FROM sync_pending WHERE project_id = ? AND id IN (${placeholders})`,
      projectId,
      ...ids
    )
  }

  private rowToEntry(row: SyncPendingRow): PendingEntry {
    const event = (() => {
      try {
        return JSON.parse(row.payload) as SyncEvent
      } catch {
        return {
          type: 'unknown.corrupt',
          path: [],
          data: null,
          timestamp: row.enqueued_at,
          projectId: row.project_id,
        } satisfies SyncEvent
      }
    })()
    return { id: row.id, event, enqueuedAt: row.enqueued_at }
  }
}

export const syncPendingStorage = new SyncPendingStorage()
export type { SyncPendingStorage }
