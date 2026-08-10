/**
 * Storage Manager Base Class (PRJ-303: SQLite-backed)
 *
 * Write path: SQLite kv_store + cache + event
 * Read path: cache → SQLite → default
 *
 * Subclasses implement specific data types (state, queue, ideas, shipped).
 */

import crypto from 'node:crypto'
import { syncEventBus } from '../events/sync-events'
import type { SyncEvent } from '../types/events'
import { TTLCache } from '../utils/cache'
import { getTimestamp } from '../utils/date-helper'
import { prjctDb } from './database'

function deriveEntityShape(legacyType: string): {
  entityType?: string
  eventType?: 'upsert' | 'delete'
} {
  const [rawEntity, rawAction] = legacyType.split('.')
  if (!rawEntity) return {}
  // Plural the entity name for cloud table mapping (`task` → `tasks`).
  const entityType = rawEntity.endsWith('s') ? rawEntity : `${rawEntity}s`
  const tombstone = rawAction === 'deleted' || rawAction === 'archived' || rawAction === 'removed'
  return { entityType, eventType: tombstone ? 'delete' : 'upsert' }
}

function entityIdOf(eventData: unknown): string | undefined {
  if (!eventData || typeof eventData !== 'object') return undefined
  const obj = eventData as Record<string, unknown>
  for (const k of ['taskId', 'task_id', 'id', 'feature_id', 'featureId', 'specId', 'spec_id']) {
    const v = obj[k]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}

function hashPayload(data: unknown): string {
  const canonical =
    data && typeof data === 'object' && !Array.isArray(data)
      ? JSON.stringify(sortKeys(data as Record<string, unknown>))
      : JSON.stringify(data)
  return crypto.createHash('sha256').update(canonical).digest('hex')
}

function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {}
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k]
  return sorted
}

/**
 * Lazy device-id resolution. Fully implemented in B6; returns
 * 'unknown-device' until then so events still flow.
 */
const deviceIdCache: { value: string | null } = { value: null }
async function _resolveDeviceId(): Promise<string> {
  if (deviceIdCache.value) return deviceIdCache.value
  try {
    // Lazy import — auth-config reaches into pathManager/file-helper which
    // would otherwise pull a heavy graph into every storage import.
    const { default: authConfig } = await import('../sync/auth-config')
    // `getDeviceId` is the B6 surface; until then this throws (caught below).
    type WithDeviceId = { getDeviceId?: () => Promise<string> }
    const ac = authConfig as unknown as WithDeviceId
    if (typeof ac.getDeviceId === 'function') {
      const deviceId = await ac.getDeviceId()
      deviceIdCache.value = deviceId
      return deviceId
    }
    return 'unknown-device'
  } catch {
    return 'unknown-device'
  }
}

export abstract class StorageManager<T> {
  protected filename: string
  protected cache: TTLCache<T>

  constructor(filename: string, _schema?: unknown) {
    this.filename = filename
    this.cache = new TTLCache<T>({ ttl: 5000, maxSize: 50 })
  }

  /**
   * Get the kv_store key for this storage type.
   * Derived from filename: 'state.json' → 'state'
   */
  protected getStoreKey(): string {
    return this.filename.replace('.json', '')
  }

  /**
   * Get default data structure
   */
  protected abstract getDefault(): T

  /**
   * Get event type for sync
   */
  protected abstract getEventType(action: 'update' | 'create' | 'delete'): string

  /**
   * Read data from storage.
   * Path: cache → SQLite kv_store → default
   */
  async read(projectId: string): Promise<T> {
    // Cross-process staleness gate: the daemon is long-lived, so its 5s TTL
    // cache can serve a value a concurrent short-lived CLI process already
    // overwrote in SQLite (the daemon never saw that write). Inside the
    // daemon, always read SQLite — it's the source of truth and the per-op
    // cost is a single indexed kv_store lookup. Short-lived CLI processes
    // keep the cache (their lifetime rarely outlives a concurrent write).
    const inDaemon = process.env.PRJCT_IN_DAEMON === '1'

    // Check cache first (with expiration)
    if (!inDaemon) {
      const cached = this.cache.get(projectId)
      if (cached !== null) {
        return cached
      }
    }

    // Try SQLite kv_store (primary store)
    try {
      const data = prjctDb.getDoc<T>(projectId, this.getStoreKey())
      if (data !== null) {
        this.cache.set(projectId, data)
        return data
      }
    } catch {
      // SQLite not available (e.g., DB dir doesn't exist yet)
    }

    return this.getDefault()
  }

  /**
   * Write data to storage.
   * SQLite primary + cache update.
   */
  async write(projectId: string, data: T): Promise<void> {
    // 1. Write to SQLite kv_store (primary)
    prjctDb.setDoc(projectId, this.getStoreKey(), data)

    // 2. Update cache
    this.cache.set(projectId, data)
  }

  /**
   * Update data with a transform function
   */
  async update(projectId: string, updater: (current: T) => T): Promise<T> {
    // Atomic read-modify-write inside one BEGIN IMMEDIATE transaction
    // (prjctDb.updateDoc). The old read→transform→write was a lost-update
    // race: the daemon and a concurrent CLI both read `state`, both wrote,
    // the second blind-overwrote the first (a paused/completed task lost).
    // The write lock is taken up front, so a concurrent writer WAITS (up to
    // busy_timeout=5000ms) and then re-reads committed state — strictly
    // stronger than the previous 8-attempt optimistic CAS loop, with one
    // SELECT + one write per update instead of up to 24 round-trips. True
    // sustained contention surfaces as SQLITE_BUSY from the driver.
    const key = this.getStoreKey()
    const updated = prjctDb.updateDoc<T>(projectId, key, updater, () => this.getDefault())
    this.cache.set(projectId, updated) // keep cache coherent with the committed write
    return updated
  }

  /**
   * Publish sync event to syncEventBus.
   *
   * Phase 1.5 / B1: enriches the event with the wire format fields
   * (entityType, entityId, eventType, contentHash, deviceId,
   * revisionCount) so prjct-cloud's applyEvent can dedupe + last-write-
   * wins desempata. The legacy `eventType` parameter (still
   * "entity.action" string) drives the derivation; explicit overrides
   * via `publishEntityEventCRUD` skip the inference.
   */
  protected async publishEvent(
    projectId: string,
    eventType: string,
    eventData: unknown
  ): Promise<void> {
    const shape = deriveEntityShape(eventType)
    const event: SyncEvent = {
      type: eventType,
      path: [this.filename.replace('.json', '')],
      data: eventData,
      timestamp: getTimestamp(),
      projectId,
      entityType: shape.entityType,
      entityId: entityIdOf(eventData),
      eventType: shape.eventType,
      contentHash: hashPayload(eventData),
      deviceId: await _resolveDeviceId(),
      revisionCount: 1,
    }

    await syncEventBus.publish(event)
  }

  /**
   * Publish an entity event with automatic type construction
   * Convenience method that builds event type from entity and action
   *
   * @param projectId - Project identifier
   * @param entity - Entity name (e.g., 'task', 'idea', 'queue', 'feature')
   * @param action - Action name (e.g., 'started', 'completed', 'created')
   * @param payload - Event data (timestamp added automatically)
   */
  protected async publishEntityEvent(
    projectId: string,
    entity: string,
    action: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    const eventType = `${entity}.${action}`
    const eventData = {
      ...payload,
      timestamp: getTimestamp(),
    }

    await this.publishEvent(projectId, eventType, eventData)
  }

  /**
   * Check if storage exists for this project.
   */
  async exists(projectId: string): Promise<boolean> {
    try {
      return prjctDb.hasDoc(projectId, this.getStoreKey())
    } catch {
      return false
    }
  }

  /**
   * Clear cache for a project
   */
  clearCache(projectId?: string): void {
    if (projectId) {
      this.cache.delete(projectId)
    } else {
      this.cache.clear()
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; maxSize: number; ttl: number } {
    return this.cache.stats()
  }
}
