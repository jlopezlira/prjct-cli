/**
 * sync-manager applyEvent idempotency — Phase 1.6 / B2 integration.
 *
 * Pins the contract that re-applying the SAME event (same content_hash
 * for the same entity) is a no-op: handler.upsert runs exactly once,
 * the second pass short-circuits via sync_applied_hashes.
 *
 * Approach: monkey-patch a spy handler into the entity registry, drive
 * applyEvent twice (via runtime cast — applyEvent is private), assert
 * call counts. This exercises the wiring (alreadyApplied probe + the
 * post-handler recordApplied call) without depending on any specific
 * entity's storage shape.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'
import prjctDb from '../../storage/database'
import { entityHandlers } from '../../sync/entity-handlers'
import type { EntityHandler } from '../../sync/entity-handlers/types'
import { syncManager } from '../../sync/sync-manager'

const TEST_ENTITY_TYPE = 'idempotency_probe'

interface SpyHandler extends EntityHandler {
  upsertCalls: Array<Record<string, unknown>>
  deleteCalls: Array<Record<string, unknown>>
}

function makeSpy(): SpyHandler {
  const upsertCalls: Array<Record<string, unknown>> = []
  const deleteCalls: Array<Record<string, unknown>> = []
  return {
    upsertCalls,
    deleteCalls,
    upsert: async (_pid, data) => {
      upsertCalls.push(data)
    },
    delete: async (_pid, data) => {
      deleteCalls.push(data)
    },
  }
}

const fixture: {
  projectId: string
  originalProjectsDir: string | undefined
  spy: SpyHandler
} = {
  projectId: '',
  originalProjectsDir: undefined as unknown as string | undefined,
  spy: undefined as unknown as SpyHandler,
}

beforeEach(async () => {
  prjctDb.close()
  const tempProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-applyev-idem-'))
  fixture.originalProjectsDir = process.env.PRJCT_PROJECTS_DIR
  process.env.PRJCT_PROJECTS_DIR = tempProjectsDir
  fixture.projectId = `applyev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await pathManager.ensureProjectStructure(fixture.projectId)
  prjctDb.run(fixture.projectId, 'SELECT 1 WHERE 1=0') // force migrations

  fixture.spy = makeSpy()
  ;(entityHandlers as Record<string, EntityHandler>)[TEST_ENTITY_TYPE] = fixture.spy
})

afterEach(() => {
  if (fixture.originalProjectsDir === undefined) delete process.env.PRJCT_PROJECTS_DIR
  else process.env.PRJCT_PROJECTS_DIR = fixture.originalProjectsDir
  delete (entityHandlers as Record<string, EntityHandler>)[TEST_ENTITY_TYPE]
  prjctDb.close()
})

// Cast around applyEvent's `private` modifier — TS-private is a
// compile-time check, the method is reachable at runtime.
async function applyEvent(event: Record<string, unknown>): Promise<void> {
  await (
    syncManager as unknown as {
      applyEvent: (pid: string, ev: Record<string, unknown>) => Promise<void>
    }
  ).applyEvent(fixture.projectId, event)
}

describe('applyEvent idempotency (Phase 1.6 / B2)', () => {
  test('re-applying the same event is a no-op (handler runs exactly once)', async () => {
    const event = {
      entity_type: TEST_ENTITY_TYPE,
      event_type: 'upsert',
      data: { id: 'entity-A', name: 'first' },
      content_hash: 'sha256:v1',
    }

    await applyEvent(event)
    await applyEvent(event) // identical re-delivery

    expect(fixture.spy.upsertCalls).toHaveLength(1)
    expect(fixture.spy.deleteCalls).toHaveLength(0)
  })

  test('different content_hash forces a re-apply (handler runs again)', async () => {
    await applyEvent({
      entity_type: TEST_ENTITY_TYPE,
      event_type: 'upsert',
      data: { id: 'entity-A' },
      content_hash: 'sha256:v1',
    })
    await applyEvent({
      entity_type: TEST_ENTITY_TYPE,
      event_type: 'upsert',
      data: { id: 'entity-A' },
      content_hash: 'sha256:v2',
    })

    expect(fixture.spy.upsertCalls).toHaveLength(2)
  })

  test('event without content_hash always applies (no idempotency probe possible)', async () => {
    const event = {
      entity_type: TEST_ENTITY_TYPE,
      event_type: 'upsert',
      data: { id: 'entity-A' },
    }

    await applyEvent(event)
    await applyEvent(event)

    expect(fixture.spy.upsertCalls).toHaveLength(2)
  })

  test('delete event clears the hash trail so a same-payload re-create re-applies', async () => {
    // Apply → record hash.
    await applyEvent({
      entity_type: TEST_ENTITY_TYPE,
      event_type: 'upsert',
      data: { id: 'entity-A', name: 'before' },
      content_hash: 'sha256:vX',
    })
    // Delete → trail cleared.
    await applyEvent({
      entity_type: TEST_ENTITY_TYPE,
      event_type: 'delete',
      data: { id: 'entity-A' },
      content_hash: 'sha256:vX',
    })
    // Re-create with the SAME content_hash that was applied originally.
    // Without the tombstone clear, this would dedupe as a no-op.
    await applyEvent({
      entity_type: TEST_ENTITY_TYPE,
      event_type: 'upsert',
      data: { id: 'entity-A', name: 'after' },
      content_hash: 'sha256:vX',
    })

    expect(fixture.spy.upsertCalls).toHaveLength(2)
    expect(fixture.spy.deleteCalls).toHaveLength(1)
  })

  test('different entity ids are tracked independently', async () => {
    await applyEvent({
      entity_type: TEST_ENTITY_TYPE,
      event_type: 'upsert',
      data: { id: 'entity-A' },
      content_hash: 'sha256:same',
    })
    await applyEvent({
      entity_type: TEST_ENTITY_TYPE,
      event_type: 'upsert',
      data: { id: 'entity-B' },
      content_hash: 'sha256:same',
    })

    expect(fixture.spy.upsertCalls).toHaveLength(2)
  })

  test('event for unknown entity_type does NOT record a hash (no handler ran)', async () => {
    await applyEvent({
      entity_type: 'no_such_handler',
      event_type: 'upsert',
      data: { id: 'orphan' },
      content_hash: 'sha256:orphan',
    })

    // Re-applying with the same hash should also no-op silently — not
    // because of dedupe (no row recorded), but because the registry
    // doesn't resolve it.
    await applyEvent({
      entity_type: 'no_such_handler',
      event_type: 'upsert',
      data: { id: 'orphan' },
      content_hash: 'sha256:orphan',
    })

    expect(fixture.spy.upsertCalls).toHaveLength(0)
    expect(fixture.spy.deleteCalls).toHaveLength(0)
  })
})
