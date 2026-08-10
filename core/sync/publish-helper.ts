/**
 * Sync publish helper — the canonical 5-line snippet a contributor
 * copy-pastes into a new `*-storage.ts` to make CRUD writes show up
 * in the sync queue (Phase 1.5 / B1).
 *
 * Builds a fully-formed `SyncEvent`:
 *   - entity_type / entity_id / event_type → wire-format discriminators
 *   - content_hash → sha256(payload), used by applyEvent for
 *     idempotency + last-write-wins desempata
 *   - device_id → from AuthConfig.deviceId (B6); falls back to
 *     'unknown-device' before first auth
 *   - revision_count → caller passes (default 1 for new rows)
 *   - timestamp → ISO 8601 wall clock (kept for debugging; pull
 *     authoritative ordering uses server_event_id from B4)
 *
 * Storage code stays terse: `publishCRUD({...})` is one call.
 *
 * IMPORTANT: this helper swallows errors. The sync queue is
 * best-effort by design — a CRUD must succeed locally even if the
 * sync queue insert fails (full disk, malformed payload). The B3
 * storage logs nothing on its own; callers that need observability
 * wrap the call themselves.
 */

import crypto from 'node:crypto'
import { syncEventBus } from '../events/sync-events'
import type { SyncEvent } from '../types/events'
export type CrudEventType = 'upsert' | 'delete'

export interface PublishCrudArgs {
  projectId: string
  /** Canonical entity name, e.g. 'tasks', 'ideas', 'shipped_features'. */
  entityType: string
  /** Stable id of the entity touched. */
  entityId: string
  /** 'upsert' for INSERT/UPDATE, 'delete' for DELETE / soft-delete. */
  eventType: CrudEventType
  /** Payload that the cloud will mirror. May be empty for deletes. */
  data: unknown
  /** Per-entity revision counter (+1 per update). Default 1. */
  revisionCount?: number
  /**
   * Origin device — first creator. For first INSERT defaults to the
   * current device. For subsequent UPDATEs callers should pass the
   * stored origin so applyEvent on other devices preserves provenance.
   */
  originDeviceId?: string
}

const LEGACY_TYPE_OF: Record<CrudEventType, string> = {
  upsert: 'updated',
  delete: 'deleted',
}

/**
 * Hash the payload deterministically. Object key order matters here —
 * we sort top-level keys before stringifying so two equivalent
 * payloads produce the same hash.
 */
export function hashPayload(data: unknown): string {
  const canonical =
    data && typeof data === 'object' && !Array.isArray(data)
      ? JSON.stringify(sortKeys(data as Record<string, unknown>))
      : JSON.stringify(data)
  return crypto.createHash('sha256').update(canonical).digest('hex')
}

function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {}
  for (const k of Object.keys(obj).sort()) {
    sorted[k] = obj[k]
  }
  return sorted
}

/**
 * Resolve the local device id. Lazy-loaded to avoid a hard dependency
 * cycle through `auth-config`. When no auth is configured (fresh
 * machine), returns a stable sentinel so events still flow into the
 * pending queue and get re-tagged at first auth.
 */
const deviceIdCache: { value: string | null } = { value: null }
async function resolveDeviceId(): Promise<string> {
  if (deviceIdCache.value) return deviceIdCache.value
  try {
    const { default: authConfig } = await import('./auth-config')
    type WithDeviceId = { getDeviceId?: () => Promise<string> }
    const ac = authConfig as unknown as WithDeviceId
    if (typeof ac.getDeviceId === 'function') {
      const id = await ac.getDeviceId()
      deviceIdCache.value = id
      return id
    }
    return 'unknown-device'
  } catch {
    return 'unknown-device'
  }
}

export async function publishCRUD(args: PublishCrudArgs): Promise<void> {
  try {
    const deviceId = await resolveDeviceId()
    const contentHash = hashPayload(args.data)
    const event: SyncEvent = {
      // Legacy compound type for back-compat with applyEvent's old branch.
      type: `${args.entityType}.${LEGACY_TYPE_OF[args.eventType]}`,
      path: [args.entityType, args.entityId],
      data: args.data,
      timestamp: new Date().toISOString(),
      projectId: args.projectId,
      entityType: args.entityType,
      entityId: args.entityId,
      eventType: args.eventType,
      contentHash,
      deviceId,
      originDeviceId: args.originDeviceId ?? deviceId,
      revisionCount: args.revisionCount ?? 1,
    }
    await syncEventBus.publish(event)
  } catch {
    // Best-effort — local CRUD must not fail because of sync.
  }
}

/**
 * Synchronous fire-and-forget variant. Most storage methods are
 * synchronous (node:sqlite / bun:sqlite) — they call this and don't block on
 * the queue insert. The promise is intentionally not awaited.
 */
export function publishCRUDSync(args: PublishCrudArgs): void {
  void publishCRUD(args)
}
