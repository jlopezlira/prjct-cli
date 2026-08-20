import { describe, expect, it } from 'bun:test'
import { mapCliEventsToWebFormat, mapCliEventToWebFormat } from '../../sync/event-mapper'
import type { SyncEvent } from '../../types/events'

function makeEvent(type: string, data: Record<string, unknown> = {}): SyncEvent {
  return {
    type,
    path: [],
    data,
    timestamp: '2026-04-10T00:00:00Z',
    projectId: 'proj-1',
  }
}

describe('mapCliEventToWebFormat', () => {
  it('maps task.created → upsert event on tasks table', () => {
    const result = mapCliEventToWebFormat(
      'proj-1',
      makeEvent('task.created', { id: 't1', title: 'hello' })
    )

    expect(result).not.toBeNull()
    expect(result?.event_type).toBe('upsert')
    expect(result?.entity_type).toBe('tasks')
    expect(result?.entity_id).toBe('t1')
    expect(result?.project_id).toBe('proj-1')
    expect(result?.data.project_id).toBe('proj-1')
  })

  it('maps task.deleted → delete event', () => {
    const result = mapCliEventToWebFormat('proj-1', makeEvent('task.deleted', { id: 't1' }))
    expect(result?.event_type).toBe('delete')
  })

  it('maps idea.created → ideas table', () => {
    const result = mapCliEventToWebFormat('proj-1', makeEvent('idea.created', { id: 'i1' }))
    expect(result?.entity_type).toBe('ideas')
  })

  it('maps feature.updated → roadmap_features table', () => {
    const result = mapCliEventToWebFormat('proj-1', makeEvent('feature.updated', { id: 'f1' }))
    expect(result?.entity_type).toBe('roadmap_features')
  })

  it('returns null for unknown entity type', () => {
    const result = mapCliEventToWebFormat('proj-1', makeEvent('unknown.created', { id: 'x1' }))
    expect(result).toBeNull()
  })

  it('converts camelCase keys to snake_case', () => {
    const result = mapCliEventToWebFormat(
      'proj-1',
      makeEvent('task.created', { id: 't1', createdAt: '2026-01-01', fooBar: 'baz' })
    )
    expect(result?.data.created_at).toBe('2026-01-01')
    expect(result?.data.foo_bar).toBe('baz')
    expect(result?.data.createdAt).toBeUndefined()
  })

  it('handles missing id gracefully', () => {
    const result = mapCliEventToWebFormat('proj-1', makeEvent('task.created', {}))
    expect(result?.entity_id).toBe('')
  })

  it('maps work-cycle task.started (taskId only) to entity_id + data.id', () => {
    // Real producer shape from state-storage: no top-level entityId, no data.id —
    // only taskId. Cloud work visibility depends on this resolving.
    const result = mapCliEventToWebFormat(
      'proj-1',
      makeEvent('task.started', {
        taskId: 'cycle-abc',
        description: 'fix work sync',
        startedAt: '2026-07-15T00:00:00Z',
        sessionId: 'sess-1',
      })
    )
    expect(result).not.toBeNull()
    expect(result?.entity_type).toBe('tasks')
    expect(result?.entity_id).toBe('cycle-abc')
    expect(result?.data.id).toBe('cycle-abc')
    expect(result?.data.task_id).toBe('cycle-abc')
    expect(result?.data.started_at).toBe('2026-07-15T00:00:00Z')
  })

  it('handles undefined data', () => {
    const event: SyncEvent = {
      type: 'task.created',
      path: [],
      data: undefined,
      timestamp: '2026-04-10T00:00:00Z',
      projectId: 'proj-1',
    }
    const result = mapCliEventToWebFormat('proj-1', event)
    expect(result).not.toBeNull()
    expect(result?.data.project_id).toBe('proj-1')
  })
})

// ---------------------------------------------------------------------------
// entityType-driven mapping — the fix that stopped silently dropping memories,
// queue_task, workflows and archives (the old mapper keyed only off the legacy
// `type` split through a partial table).
// ---------------------------------------------------------------------------
describe('mapCliEventToWebFormat — entityType-driven', () => {
  function publishedEvent(
    entityType: string,
    eventType: 'upsert' | 'delete',
    data: Record<string, unknown>
  ): SyncEvent {
    return {
      // publishCRUD always sets these top-level fields…
      type: `${entityType}.${eventType === 'delete' ? 'deleted' : 'updated'}`,
      path: [entityType, (data.id as string) ?? ''],
      data,
      timestamp: '2026-06-19T00:00:00Z',
      projectId: 'proj-1',
      entityType,
      eventType,
      entityId: (data.id as string) ?? '',
    }
  }

  it('maps a memory upsert to the memories table (was dropped before)', () => {
    const result = mapCliEventToWebFormat(
      'proj-1',
      publishedEvent('memories', 'upsert', { id: 'mem-1', type: 'decision', content: 'use X' })
    )
    expect(result).not.toBeNull()
    expect(result?.entity_type).toBe('memories')
    expect(result?.event_type).toBe('upsert')
    expect(result?.entity_id).toBe('mem-1')
  })

  it('maps queue_task / custom_workflows / archives producers (all previously dropped)', () => {
    expect(
      mapCliEventToWebFormat('proj-1', publishedEvent('queue_task', 'upsert', { id: 'q1' }))
        ?.entity_type
    ).toBe('queue_tasks')
    expect(
      mapCliEventToWebFormat('proj-1', publishedEvent('custom_workflows', 'upsert', { id: 'w1' }))
        ?.entity_type
    ).toBe('custom_workflows')
    expect(
      mapCliEventToWebFormat('proj-1', publishedEvent('archives', 'upsert', { id: 'a1' }))
        ?.entity_type
    ).toBe('archives')
  })

  it('maps inference cost snapshots to cloud metrics analytics', () => {
    const result = mapCliEventToWebFormat(
      'proj-1',
      publishedEvent('inference_cost_snapshots', 'upsert', {
        id: 'inference-cost-7d',
        windowDays: 7,
        simulatedUsd: 5.9,
        models: [{ model: 'grok-4.6', inputPerMillion: 2, simulatedUsd: 5 }],
      })
    )
    expect(result?.entity_type).toBe('inference_cost_snapshots')
    expect(result?.entity_id).toBe('inference-cost-7d')
    expect(result?.data.window_days).toBe(7)
    expect(result?.data.simulated_usd).toBe(5.9)
  })

  it('maps work cost snapshots to cloud metrics analytics', () => {
    const result = mapCliEventToWebFormat(
      'proj-1',
      publishedEvent('work_cost_snapshots', 'upsert', {
        id: 'work-cost-30d',
        windowDays: 30,
        tokensTotal: 55000,
      })
    )
    expect(result?.entity_type).toBe('work_cost_snapshots')
    expect(result?.entity_id).toBe('work-cost-30d')
    expect(result?.data.window_days).toBe(30)
    expect(result?.data.tokens_total).toBe(55000)
  })

  it('honors the explicit eventType=delete over the legacy action', () => {
    const result = mapCliEventToWebFormat(
      'proj-1',
      publishedEvent('memories', 'delete', { id: 'mem-1', type: 'decision', content: 'use X' })
    )
    expect(result?.event_type).toBe('delete')
  })

  it('prefers the explicit entityId field over data.id', () => {
    const ev = publishedEvent('memories', 'upsert', { id: 'data-id' })
    ev.entityId = 'explicit-id'
    expect(mapCliEventToWebFormat('proj-1', ev)?.entity_id).toBe('explicit-id')
  })
})

describe('mapCliEventsToWebFormat', () => {
  it('maps all valid events and drops unknown ones', () => {
    const events: SyncEvent[] = [
      makeEvent('task.created', { id: 't1' }),
      makeEvent('unknown.x', { id: 'x' }),
      makeEvent('idea.created', { id: 'i1' }),
    ]
    const result = mapCliEventsToWebFormat('proj-1', events)
    expect(result).toHaveLength(2)
    expect(result[0].entity_type).toBe('tasks')
    expect(result[1].entity_type).toBe('ideas')
  })

  it('returns empty array for empty input', () => {
    expect(mapCliEventsToWebFormat('proj-1', [])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Phase 1.6 / B1 — wire passthrough for echo-loop + LWW fields
// ---------------------------------------------------------------------------
// The 3 fields below already exist on the `SyncEvent` type since Phase
// 1.5/B5 but the mapper used to drop them silently. These tests pin the
// new contract: top-level on the wire payload, optional, and backward
// compatible with legacy events that don't populate them.
describe('mapCliEventToWebFormat — Phase 1.6/B1 wire passthrough', () => {
  it('propagates originDeviceId, contentHash, revisionCount, ts as TOP-LEVEL fields', () => {
    const event: SyncEvent = {
      type: 'task.created',
      path: [],
      data: { id: 't1', title: 'hello' },
      timestamp: '2026-05-05T03:14:09Z',
      projectId: 'proj-1',
      originDeviceId: 'dev-uuid-1',
      contentHash: 'sha256:abc123',
      revisionCount: 7,
    }
    const result = mapCliEventToWebFormat('proj-1', event)
    expect(result).not.toBeNull()
    if (!result) return

    expect(result.origin_device_id).toBe('dev-uuid-1')
    expect(result.content_hash).toBe('sha256:abc123')
    expect(result.revision_count).toBe(7)
    expect(result.ts).toBe('2026-05-05T03:14:09Z')

    // The 3 dedupe fields must NOT leak into the snake_cased data blob —
    // the server reads them top-level. Mirroring them inside `data` would
    // double-cost serialization and confuse downstream consumers.
    expect(result.data.origin_device_id).toBeUndefined()
    expect(result.data.content_hash).toBeUndefined()
    expect(result.data.revision_count).toBeUndefined()
    expect(result.data.ts).toBeUndefined()
  })

  it('omits the new top-level fields when the producer did not populate them (backward compat)', () => {
    const result = mapCliEventToWebFormat(
      'proj-1',
      makeEvent('task.created', { id: 't1' }) // no originDeviceId/contentHash/revisionCount
    )
    expect(result).not.toBeNull()
    if (!result) return

    // Optional fields elided rather than emitted as undefined or null —
    // the wire payload stays compact and matches what JSON.stringify
    // produces for absent properties.
    expect('origin_device_id' in result).toBe(false)
    expect('content_hash' in result).toBe(false)
    expect('revision_count' in result).toBe(false)

    // ts is always emitted because every SyncEvent carries timestamp.
    expect(result.ts).toBe('2026-04-10T00:00:00Z')

    // Existing-shape invariants must still hold.
    expect(result.event_type).toBe('upsert')
    expect(result.entity_type).toBe('tasks')
    expect(result.entity_id).toBe('t1')
    expect(result.project_id).toBe('proj-1')
  })

  it('preserves project_id duplication (top-level AND inside data) for legacy consumers', () => {
    const event: SyncEvent = {
      type: 'task.created',
      path: [],
      data: { id: 't1' },
      timestamp: '2026-05-05T00:00:00Z',
      projectId: 'proj-1',
      originDeviceId: 'dev-uuid-1',
    }
    const result = mapCliEventToWebFormat('proj-1', event)
    expect(result?.project_id).toBe('proj-1')
    expect(result?.data.project_id).toBe('proj-1')
  })

  it('survives a SyncEvent with revisionCount=0 (falsy but valid value)', () => {
    const event: SyncEvent = {
      type: 'task.created',
      path: [],
      data: { id: 't1' },
      timestamp: '2026-05-05T00:00:00Z',
      projectId: 'proj-1',
      revisionCount: 0,
    }
    const result = mapCliEventToWebFormat('proj-1', event)
    expect(result?.revision_count).toBe(0)
  })

  it('JSON round-trip preserves the 4 fields (server-side parse perspective)', () => {
    const event: SyncEvent = {
      type: 'task.created',
      path: [],
      data: { id: 't1' },
      timestamp: '2026-05-05T03:14:09Z',
      projectId: 'proj-1',
      originDeviceId: 'dev-uuid-1',
      contentHash: 'sha256:abc',
      revisionCount: 3,
    }
    const wire = mapCliEventToWebFormat('proj-1', event)
    const reparsed = JSON.parse(JSON.stringify(wire))

    expect(reparsed.origin_device_id).toBe('dev-uuid-1')
    expect(reparsed.content_hash).toBe('sha256:abc')
    expect(reparsed.revision_count).toBe(3)
    expect(reparsed.ts).toBe('2026-05-05T03:14:09Z')
  })
})
