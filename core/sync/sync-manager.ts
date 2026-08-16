/**
 * Sync Manager - Orchestrates push/pull operations
 *
 * Main entry point for sync operations.
 * Handles the coordination between local storage (EventBus) and remote API (SyncClient).
 */

import { syncEventBus } from '../events/sync-events'
import { buildProjectMeta } from '../services/sync/project-meta'
import { shippedStorage } from '../storage/shipped-storage'
import type { SyncEvent } from '../types/events'
import type {
  PullResult,
  PushResult,
  SyncBatchResult,
  SyncErrorCode,
  SyncPullResult,
  SyncManagerResult as SyncResult,
  SyncStatus,
} from '../types/sync'
import { hashPayload } from '../utils/hash'
import authConfig from './auth-config'
import { entityHandlers, UNKNOWN_ENTITY_TYPES } from './entity-handlers'
import { isTableIncluded, toCloudTable } from './entity-map'
import { clearApplied, getApplied, recordApplied } from './sync-applied-hashes'
import { syncClient } from './sync-client'

// Per-process dedupe for the "no local handler" warn — without this,
// pulling a batch of 50 events for an unhandled entity_type would emit
// 50 identical warns. Reset on process restart, which is fine: the warn
// is a development-time signal, not a production log line.
const WARN_LOGGED: Set<string> = new Set()

function warnNoLocalHandler(entityType: string): void {
  if (WARN_LOGGED.has(entityType)) return
  WARN_LOGGED.add(entityType)
  const known = UNKNOWN_ENTITY_TYPES.has(entityType)
  const reason = known
    ? 'CLI does not track this entity locally yet — see Phase 2 spec'
    : 'no local handler registered'
  console.warn(
    `[sync] apply skipped: entity_type='${entityType}' (${reason}). code=no_local_handler`
  )
}

// Per-process dedupe for the "inbound event has no origin created_at"
// warn. A producer that omits created_at from its payload forces the
// receiver to lose origin chronology; this surfaces it once per
// entity_type instead of per-event.
const WARN_CREATED_AT: Set<string> = new Set()

function warnMissingCreatedAt(entityType: string): void {
  if (WARN_CREATED_AT.has(entityType)) return
  WARN_CREATED_AT.add(entityType)
  console.warn(
    `[sync] inbound '${entityType}' event has no created_at — origin chronology ` +
      `cannot be preserved. The producer should include created_at in its payload. ` +
      `code=missing_origin_created_at`
  )
}

/**
 * @internal — exposed for tests so a fresh process state can be
 * simulated without spawning a child. Do not call from prod code.
 */
export function _resetWarnDedupeForTest(): void {
  WARN_LOGGED.clear()
  WARN_CREATED_AT.clear()
}

// Event normalization (Phase 1.5 / B2)

interface NormalizedEvent {
  entityType: string
  eventType: 'upsert' | 'delete'
  data: Record<string, unknown>
  contentHash?: string
}

/**
 * Normalize an inbound event from either web format
 * (`entity_type` + `event_type`) or legacy CLI format
 * (`type: "entity.action"`). Returns the wire shape applyEvent
 * expects.
 */
function normalizeEventShape(event: Record<string, unknown>): NormalizedEvent {
  const data = (event.data as Record<string, unknown>) ?? {}
  const contentHash =
    (event.content_hash as string | undefined) ?? (event.contentHash as string | undefined)

  if (event.entity_type) {
    const eventType = ((event.event_type as string) || 'upsert') === 'delete' ? 'delete' : 'upsert'
    return {
      entityType: event.entity_type as string,
      eventType,
      data,
      contentHash,
    }
  }

  // entityType field on the new SyncEvent (from B5 producers).
  if (event.entityType) {
    const et = (event.eventType as string) || 'upsert'
    return {
      entityType: event.entityType as string,
      eventType: et === 'delete' ? 'delete' : 'upsert',
      data,
      contentHash,
    }
  }

  // Legacy CLI format: type = "entity.action"
  const [entity, action] = ((event.type as string) || '').split('.')
  const tombstone = action === 'deleted' || action === 'archived' || action === 'removed'
  return {
    entityType: toCloudTable(entity) || entity || 'unknown',
    eventType: tombstone ? 'delete' : 'upsert',
    data,
    contentHash,
  }
}

// Sync Manager

/** Options threaded from the cloud command / autoSync into a sync run. */
export interface SyncOptions {
  /** Per-group whitelist from `config.cloud.include`; filters the push batch. */
  include?: Record<string, boolean>
}

/**
 * Extract a human message from a thrown value. SyncClient rejects with a
 * plain `SyncClientError` object (NOT an Error instance), so the naive
 * `error instanceof Error` check dropped the server's message — including
 * the 402 upgrade text. This recovers it from either shape.
 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return 'Unknown error'
}

/**
 * Recover the SyncClientError `code` (e.g. PAYMENT_REQUIRED for the server's
 * 402 paid gate) so the cloud command can show a tailored message instead of a
 * generic error. Same caveat as errorMessage: the client rejects with a plain
 * object, not an Error.
 */
function errorCode(error: unknown): SyncErrorCode | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    return (error as { code?: SyncErrorCode }).code
  }
  return undefined
}

class SyncManager {
  /**
   * Check if user is authenticated
   */
  async hasAuth(): Promise<boolean> {
    return await authConfig.hasAuth()
  }

  /**
   * Get sync status from API
   */
  async getStatus(projectId: string): Promise<SyncStatus | null> {
    if (!(await this.hasAuth())) {
      return null
    }

    try {
      return await syncClient.getStatus(projectId)
    } catch (_error) {
      return null
    }
  }

  /**
   * Full sync: push local changes, then pull remote changes.
   *
   * `opts.include` is the project's per-group whitelist (from
   * `config.cloud.include`); when supplied, push filters the pending
   * queue to the included entity groups. Omit it (e.g. legacy callers /
   * tests) to push everything mappable.
   */
  async sync(projectId: string, opts?: SyncOptions): Promise<SyncResult> {
    // Check auth first
    if (!(await this.hasAuth())) {
      return { success: true, skipped: true, reason: 'no_auth' }
    }

    const result: SyncResult = { success: true, skipped: false }

    // One-time per project: re-publish historical ships as canonical events so
    // ships shipped before the canonical-event fix reach the cloud. Best-effort
    // — the enqueued events ride the push below; the normal queue owns delivery.
    try {
      await shippedStorage.republishShips(projectId)
    } catch {
      // never block sync on the backfill
    }

    const pushResult = await this.push(projectId, opts)
    if (pushResult.success && !pushResult.skipped) {
      result.pushed = {
        count: pushResult.count || 0,
        syncedAt: pushResult.syncedAt || new Date().toISOString(),
      }
    }

    const pullResult = await this.pull(projectId)
    if (pullResult.success && !pullResult.skipped) {
      result.pulled = {
        count: pullResult.count || 0,
        syncedAt: pullResult.syncedAt || new Date().toISOString(),
      }
    }

    if (!pushResult.success || !pullResult.success) {
      result.success = false
      result.error = pushResult.error || pullResult.error
      result.code = pushResult.code || pullResult.code
    }

    return result
  }

  /**
   * Push local pending events to the server.
   *
   * When `opts.include` is set, events whose canonical storage table is not
   * in an included group are dropped from this batch (the per-project
   * opt-out). They stay in `sync_pending` only if still unconfirmed — here
   * we clear the full queue on success, so excluded events are dropped for
   * good, which is the intended "don't sync this group" behaviour.
   */
  async push(projectId: string, opts?: SyncOptions): Promise<PushResult> {
    // Check auth first
    if (!(await this.hasAuth())) {
      return { success: true, skipped: true, reason: 'no_auth' }
    }

    try {
      // Get pending events, applying the per-project include filter.
      const allPending = await syncEventBus.getPending(projectId)
      const pending = opts?.include
        ? allPending.filter((e) => {
            const table = toCloudTable(e.entityType) ?? toCloudTable(e.type?.split('.')[0])
            return table ? isTableIncluded(table, opts.include) : true
          })
        : allPending

      if (pending.length === 0) {
        return { success: true, skipped: true, reason: 'no_pending' }
      }

      // Prepend a project upsert event to ensure the project exists on the web side
      const projectEvent = await this.createProjectLinkEvent(projectId)
      const eventsToSend = projectEvent ? [projectEvent, ...pending] : pending

      // Push to server
      const result: SyncBatchResult = await syncClient.pushEvents(projectId, eventsToSend)

      if (result.success) {
        // Clear pending events on success
        await syncEventBus.clearPending(projectId)
        await syncEventBus.updateLastSync(projectId)

        return {
          success: true,
          skipped: false,
          count: result.processed,
          syncedAt: result.syncedAt,
        }
      } else {
        // Partial success - some events failed
        const successCount = result.processed
        const errorCount = result.errors.length
        const errorMessages = result.errors.map((e) => e.error).join(', ')

        return {
          success: false,
          skipped: false,
          count: successCount,
          syncedAt: result.syncedAt,
          error: `${errorCount} events failed: ${errorMessages}`,
        }
      }
    } catch (error) {
      return {
        success: false,
        skipped: false,
        reason: 'error',
        error: errorMessage(error),
        code: errorCode(error),
      }
    }
  }

  /**
   * Pull remote changes from the server.
   *
   * Phase 1.5 / B4: cursor moved from `last-sync.json` (timestamp,
   * clock-skew-prone) to `sync_cursors(user_id, device_id, project_id)
   * → last_event_id`.
   *
   * Phase 1.6 / B4: the legacy `sinceTimestamp` fallback is no longer
   * sent. prjct-cloud is pre-MVP — there are no pre-1.5 servers in
   * production for the timestamp to bridge. Sending only
   * `sinceEventId` simplifies the wire and removes a parallel cursor
   * that could disagree with the monotonic event_id under rebase /
   * partial pulls.
   */
  async pull(projectId: string): Promise<PullResult> {
    if (!(await this.hasAuth())) {
      return { success: true, skipped: true, reason: 'no_auth' }
    }

    try {
      const { syncCursorStorage } = await import('../storage/sync-cursor-storage')
      const auth = await authConfig.read()
      const deviceId = auth.deviceId ?? null
      const userId = auth.userId ?? null

      const cursor = deviceId ? syncCursorStorage.get(projectId, userId, deviceId) : null
      const sinceEventId = cursor?.lastEventId ?? 0

      const result: SyncPullResult = await syncClient.pullEvents(projectId, sinceEventId)

      if (result.events.length === 0) {
        await syncEventBus.updateLastSync(projectId)
        return {
          success: true,
          skipped: false,
          count: 0,
          applied: 0,
          syncedAt: result.syncedAt,
        }
      }

      const applied = await this.applyPulledEvents(projectId, result.events)

      // Advance the cursor to the highest server_event_id we've seen.
      // event records may carry it as `event_id` (web) or `eventId` (B5).
      const highest = (result.events as Array<Record<string, unknown>>)
        .flatMap((event) => [event.event_id, event.eventId])
        .filter((candidate): candidate is number => typeof candidate === 'number')
        .reduce((maximum, candidate) => Math.max(maximum, candidate), sinceEventId)
      if (deviceId && highest > sinceEventId) {
        syncCursorStorage.advance(projectId, highest, { userId, deviceId })
      }

      await syncEventBus.updateLastSync(projectId)

      return {
        success: true,
        skipped: false,
        count: result.events.length,
        applied,
        syncedAt: result.syncedAt,
      }
    } catch (error) {
      return {
        success: false,
        skipped: false,
        reason: 'error',
        error: errorMessage(error),
        code: errorCode(error),
      }
    }
  }

  /**
   * Apply pulled events to local storage
   * Accepts events in web format (entity_type/event_type) or legacy CLI format (type with dots)
   * Returns number of events successfully applied
   */
  async applyPulledEvents(
    projectId: string,
    events: Array<Record<string, unknown>>
  ): Promise<number> {
    const appliedEvents: Array<Record<string, unknown>> = []

    for (const event of events) {
      try {
        await this.applyEvent(projectId, event)
        appliedEvents.push(event)
      } catch (error) {
        const eventLabel = (event.entity_type as string) || (event.type as string) || 'unknown'
        console.error(`Failed to apply event ${eventLabel}:`, error)
      }
    }

    return appliedEvents.length
  }

  /**
   * Apply a single event delivered over the realtime channel. Returns true
   * if applied, false if skipped (echo from this device) or on apply error.
   *
   * Echo-loop guard: events whose `origin_device_id` is THIS device are
   * skipped (the server already filters them; this is defence-in-depth). On
   * success the pull cursor is advanced to the event's server id so a later
   * pull doesn't re-fetch what realtime already applied.
   */
  async applyRealtimeEvent(projectId: string, event: Record<string, unknown>): Promise<boolean> {
    try {
      const auth = await authConfig.read()
      const selfDevice = auth.deviceId ?? null
      const origin =
        (event.origin_device_id as string | undefined) ??
        (event.originDeviceId as string | undefined)
      if (selfDevice && origin && origin === selfDevice) return false

      await this.applyEvent(projectId, event)

      const evId =
        typeof event.event_id === 'number'
          ? event.event_id
          : typeof event.eventId === 'number'
            ? event.eventId
            : null
      if (evId !== null) {
        const { syncCursorStorage } = await import('../storage/sync-cursor-storage')
        const userId = auth.userId ?? null
        const deviceId = auth.deviceId ?? null
        if (deviceId) {
          const cursor = syncCursorStorage.get(projectId, userId, deviceId)
          if (!cursor || evId > cursor.lastEventId) {
            syncCursorStorage.advance(projectId, evId, { userId, deviceId })
          }
        }
      }
      return true
    } catch (error) {
      console.error('[realtime] apply failed:', error instanceof Error ? error.message : error)
      return false
    }
  }

  /**
   * Apply a single pulled event to local storage.
   *
   * Phase 1.5 / B2 + handler-registry refactor:
   *   - Upsert-by-id (no more `addTask` / `addIdea` that duplicate).
   *   - Honors `event_type === 'delete'` with entity-specific
   *     tombstones (clear-current-task, mark-archived for ideas,
   *     drop from queue, no-op for append-only shipped_*).
   *   - The per-entity logic lives in `core/sync/entity-handlers/`;
   *     this method just normalizes the event shape and dispatches.
   *     Adding a new entity_type = new handler file + 1 line in the
   *     registry. No edits here.
   *   - Idempotency via content_hash: if the incoming hash matches
   *     what we already have, skip. Last-write-wins desempata when
   *     two devices update the same entity in parallel — the higher
   *     server_event_id wins (callers feed events in order).
   *
   * Supports both web format (`entity_type` + `event_type`) and legacy
   * CLI format (`type: "entity.action"`). Output is the same.
   */
  private async applyEvent(projectId: string, event: Record<string, unknown>): Promise<void> {
    const { entityType, eventType, data, contentHash } = normalizeEventShape(event)
    const entityId = (data.id as string | undefined) ?? ''

    const handler = entityHandlers[entityType]
    if (!handler) {
      // Phase 1.6 / B3: emit a stable warn instead of returning
      // silently. Known unhandled types (roadmap_features, projects)
      // are listed in UNKNOWN_ENTITY_TYPES; brand-new types not on
      // either list still warn so a CI exhaustiveness test can flag
      // them. Per-process dedupe keeps batch pulls quiet.
      warnNoLocalHandler(entityType)
      return
    }

    if (eventType === 'delete') {
      // Deletes are id-idempotent in the handlers themselves AND must
      // not be deduped by the upsert hash trail. Otherwise a delete
      // following an upsert with the same content_hash would short-
      // circuit and the entity would never be removed locally.
      await handler.delete(projectId, data)
      if (entityId) clearApplied(projectId, entityType, entityId)
      return
    }

    // Upsert path: idempotency probe first (Phase 1.6 / B2). If this
    // entity's last applied content_hash matches the incoming one,
    // skip the handler — re-apply would be a no-op.
    if (contentHash && this.alreadyApplied(projectId, entityType, entityId, contentHash)) {
      return
    }

    await handler.upsert(projectId, data)
    // Record AFTER handler success — handler durability is the source
    // of truth, this just trails what we last applied.
    //
    // Meta recording is decoupled from contentHash: legacy producers
    // (publishEvent, e.g. queue/shipped) don't carry a hash, but we
    // still need their per-record created_at/synced_at. Fall back to a
    // hash of the payload so every applied upsert gets a side-table row.
    if (entityId) {
      // Origin creation time from the wire payload. NEVER substitute
      // local now() here: created_at must reflect when the entity was
      // authored on its origin machine, not when we ingested it
      // (that's applied_at / synced_at, stamped inside recordApplied).
      // Missing origin is a producer bug — warn once so it surfaces.
      const originCreatedAt =
        (data.created_at as string | undefined) ?? (data.createdAt as string | undefined) ?? null
      if (!originCreatedAt) warnMissingCreatedAt(entityType)
      const effectiveHash = contentHash ?? hashPayload(data)
      recordApplied(projectId, entityType, entityId, effectiveHash, originCreatedAt)
    }
  }

  /**
   * Idempotency probe: did we already apply an event with this
   * content_hash for this entity? Reads sync_applied_hashes side table
   * (migration 19). Returns false on missing entityId, missing row, or
   * lookup error — apply proceeds rather than blocking.
   */
  private alreadyApplied(
    projectId: string,
    entityType: string,
    entityId: string,
    contentHash: string
  ): boolean {
    if (!entityId) return false
    const last = getApplied(projectId, entityType, entityId)
    return last !== null && last === contentHash
  }

  /**
   * Create a project link event to ensure the web side knows about this CLI project
   */
  private async createProjectLinkEvent(projectId: string): Promise<SyncEvent | null> {
    try {
      // Sanitized repo facts (provider, branch, stack, sync health) ride along
      // so the web app can identify the project; refreshed on every sync.
      const meta = await buildProjectMeta(projectId).catch(() => ({}))
      return {
        type: 'project.updated',
        path: ['project'],
        data: {
          id: projectId,
          cli_project_id: projectId,
          meta,
        },
        timestamp: new Date().toISOString(),
        projectId,
      }
    } catch {
      return null
    }
  }
}

export const syncManager = new SyncManager()
export default syncManager
