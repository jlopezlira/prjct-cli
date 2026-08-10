/**
 * Shipped Storage
 *
 * Schema v2 (C5): ships are stored in the typed `shipped_features` table —
 * indexed columns for the hot fields (name, version, shipped_at) and a cold
 * `data` JSON column for the rare extras (tasks, agent, changes). Reads are
 * bounded indexed queries, NOT a parse of the whole history: `getRecent` is a
 * `LIMIT`, `getCount` is a `COUNT(*)`. The legacy `kv_store['shipped']` blob
 * (read + rewritten whole on every ship) is retired by migration 51, which
 * also backfills it into this table.
 *
 * `addShipped` is idempotent via the natural-key UNIQUE index
 * (name, version, shipped_at) — re-applying a pulled ship is a no-op, closing
 * the duplication that had grown the blob to 33k rows for 41 real ships.
 */

import { generateUUID } from '../schemas/schemas'
import { ShippedJsonSchema } from '../schemas/shipped'
import type { ShippedFeature, ShippedJson } from '../types/storage'
import { getDaysAgo, getTimestamp } from '../utils/date-helper'
import { ARCHIVE_POLICIES, archiveStorage } from './archive-storage'
import { prjctDb } from './database'
import { StorageManager } from './storage-manager'

// Per-project guard so the historical-ship backfill runs once. Bump the suffix
// to force a re-backfill in a future release.
const SHIP_BACKFILL_FLAG = 'shipped:backfilled:v1'

/** A row of the typed `shipped_features` table. */
interface ShippedFeatureRow {
  id: string
  name: string
  shipped_at: string
  version: string
  description: string | null
  type: string | null
  duration: string | null
  data: string | null
}

/** Reconstruct a full `ShippedFeature` from a typed row + its cold `data` JSON. */
function rowToFeature(row: ShippedFeatureRow): ShippedFeature {
  const extra = (() => {
    if (!row.data) return {}
    try {
      return JSON.parse(row.data) as Partial<ShippedFeature>
    } catch {
      return {}
    }
  })()
  const feature: ShippedFeature = {
    ...extra,
    id: row.id,
    name: row.name,
    shippedAt: row.shipped_at,
    version: row.version,
  }
  if (row.description != null) feature.description = row.description
  if (row.type != null) feature.type = row.type as ShippedFeature['type']
  if (row.duration != null) feature.duration = row.duration
  return feature
}

class ShippedStorage extends StorageManager<ShippedJson> {
  constructor() {
    super('shipped.json', ShippedJsonSchema)
  }

  // Vestigial abstract-method implementations — the base blob read/write path
  // is no longer used (all methods below query the typed table). Kept only so
  // `publishEvent` (the sync surface) stays available on this class.
  protected getDefault(): ShippedJson {
    return { shipped: [], lastUpdated: '' }
  }

  protected getEventType(action: 'update' | 'create' | 'delete'): string {
    return `shipped.${action}d`
  }

  // =========== Domain Methods ===========

  /** All ships, newest first. */
  async getAll(projectId: string): Promise<ShippedFeature[]> {
    return prjctDb
      .query<ShippedFeatureRow>(
        projectId,
        'SELECT * FROM shipped_features ORDER BY shipped_at DESC'
      )
      .map(rowToFeature)
  }

  /**
   * One-time backfill: re-publish every locally-stored ship as a canonical
   * `shipped_item.created` event so ships shipped BEFORE the canonical-event fix
   * finally reach the cloud. Guarded by a per-project kv flag so it runs once;
   * idempotent server-side via (project_id, entity_id, content_hash) dedup.
   */
  async republishShips(projectId: string): Promise<number> {
    if (prjctDb.getDoc<{ at: string }>(projectId, SHIP_BACKFILL_FLAG)) return 0
    const ships = await this.getAll(projectId)
    for (const ship of ships) {
      await this.publishEvent(projectId, 'shipped_item.created', {
        id: ship.id,
        shipId: ship.id,
        name: ship.name,
        version: ship.version,
        shippedAt: ship.shippedAt,
      })
    }
    prjctDb.setDoc(projectId, SHIP_BACKFILL_FLAG, { at: getTimestamp(), count: ships.length })
    return ships.length
  }

  /** Recent ships — a bounded indexed query, not a full-history read. */
  async getRecent(projectId: string, limit: number = 5): Promise<ShippedFeature[]> {
    return prjctDb
      .query<ShippedFeatureRow>(
        projectId,
        'SELECT * FROM shipped_features ORDER BY shipped_at DESC LIMIT ?',
        limit
      )
      .map(rowToFeature)
  }

  /**
   * Record a shipped feature. Idempotent: the natural-key UNIQUE index means
   * re-applying the same (name, version, shipped_at) is a no-op — pulled ships
   * from other machines never accrete duplicates.
   */
  async addShipped(
    projectId: string,
    feature: Omit<ShippedFeature, 'id' | 'shippedAt'>,
    // Optional authored time — when applying a pulled ship from another machine,
    // preserve its original date instead of stamping "now".
    shippedAt?: string
  ): Promise<ShippedFeature> {
    const shipped: ShippedFeature = {
      ...feature,
      id: generateUUID(),
      shippedAt: shippedAt || getTimestamp(),
    }

    const result = prjctDb.run(
      projectId,
      `INSERT OR IGNORE INTO shipped_features
         (id, name, shipped_at, version, description, type, duration, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      shipped.id,
      shipped.name,
      shipped.shippedAt,
      shipped.version ?? '',
      shipped.description ?? null,
      shipped.type ?? null,
      shipped.duration ?? null,
      JSON.stringify(shipped)
    )

    // Natural-key collision (the row already exists — typically a sync pull
    // re-applying a ship we already have): return the EXISTING row and publish
    // NOTHING. Publishing here minted a fresh event id per re-apply, so every
    // pull echoed a "new" ship back to the cloud and other devices re-pulled
    // it — the unbounded ping-pong that grew the legacy blob to 33k rows.
    if (result.changes === 0) {
      const existing = prjctDb.get<ShippedFeatureRow>(
        projectId,
        'SELECT * FROM shipped_features WHERE name = ? AND version = ? AND shipped_at = ?',
        shipped.name,
        shipped.version ?? '',
        shipped.shippedAt
      )
      if (existing) return rowToFeature(existing)
      return shipped
    }

    // Publish a canonical `shipped_item` event for cloud sync (unchanged wire).
    await this.publishEvent(projectId, 'shipped_item.created', {
      id: shipped.id,
      shipId: shipped.id,
      name: shipped.name,
      version: shipped.version,
      shippedAt: shipped.shippedAt,
    })

    return shipped
  }

  /** Most recent ship for a version. */
  async getByVersion(projectId: string, version: string): Promise<ShippedFeature | undefined> {
    const row = prjctDb.get<ShippedFeatureRow>(
      projectId,
      'SELECT * FROM shipped_features WHERE version = ? ORDER BY shipped_at DESC LIMIT 1',
      version
    )
    return row ? rowToFeature(row) : undefined
  }

  /** Total ships — a COUNT, not a length of a parsed array. */
  async getCount(projectId: string): Promise<number> {
    return (
      prjctDb.get<{ c: number }>(projectId, 'SELECT COUNT(*) AS c FROM shipped_features')?.c ?? 0
    )
  }

  /**
   * Ships in a date range. `shipped_at` is ISO-8601 UTC text, so lexicographic
   * comparison is chronological.
   */
  async getByDateRange(
    projectId: string,
    startDate: Date,
    endDate: Date
  ): Promise<ShippedFeature[]> {
    return prjctDb
      .query<ShippedFeatureRow>(
        projectId,
        'SELECT * FROM shipped_features WHERE shipped_at >= ? AND shipped_at <= ? ORDER BY shipped_at DESC',
        startDate.toISOString(),
        endDate.toISOString()
      )
      .map(rowToFeature)
  }

  /** Ship count for a period. */
  async getStats(
    projectId: string,
    period: 'week' | 'month' | 'year' = 'month'
  ): Promise<{ count: number; period: string }> {
    const now = new Date()
    const startDate =
      period === 'week'
        ? new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
        : period === 'month'
          ? new Date(now.getFullYear(), now.getMonth(), 1)
          : new Date(now.getFullYear(), 0, 1)

    const shipped = await this.getByDateRange(projectId, startDate, now)
    return { count: shipped.length, period }
  }

  /**
   * Archive shipped features older than retention period (PRJ-267). Moves old
   * rows to the archive table and deletes them from the active table.
   */
  async archiveOldShipped(projectId: string): Promise<number> {
    const thresholdIso = getDaysAgo(ARCHIVE_POLICIES.SHIPPED_RETENTION_DAYS).toISOString()

    const stale = prjctDb
      .query<ShippedFeatureRow>(
        projectId,
        'SELECT * FROM shipped_features WHERE shipped_at < ? ORDER BY shipped_at DESC',
        thresholdIso
      )
      .map(rowToFeature)

    if (stale.length === 0) return 0

    archiveStorage.archiveMany(
      projectId,
      stale.map((s) => ({
        entityType: 'shipped' as const,
        entityId: s.id,
        entityData: s,
        summary: `${s.name} v${s.version}`,
        reason: 'age',
      }))
    )

    prjctDb.run(projectId, 'DELETE FROM shipped_features WHERE shipped_at < ?', thresholdIso)

    await this.publishEvent(projectId, 'shipped.archived', {
      count: stale.length,
      oldestShippedAt: stale[stale.length - 1]?.shippedAt,
    })

    return stale.length
  }
}

export const shippedStorage = new ShippedStorage()
