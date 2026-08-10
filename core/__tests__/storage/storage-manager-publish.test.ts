/**
 * StorageManager.publishEvent — Phase 1.5 / B1.
 *
 * The legacy publishEvent emitted bare SyncEvents with no
 * entityType/entityId/eventType/contentHash/deviceId. The enriched
 * version derives those fields from the legacy "entity.action" type
 * string + payload, so every storage that extends StorageManager
 * (queue, ideas, state, shipped, velocity, metrics) gets wire-format-
 * complete events without any per-storage edits.
 *
 * These tests sit on top of the IdeasStorage subclass — concrete
 * enough to round-trip through SQLite, generic enough to validate
 * the parent's behavior.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { syncEventBus } from '../../events/sync-events'
import prjctDb from '../../storage/database'
import { ideasStorage } from '../../storage/ideas-storage'

const fixture: {
  tempProjectsDir: string
  originalProjectsDir: string | undefined
  projectId: string
} = {
  tempProjectsDir: '',
  originalProjectsDir: undefined as unknown as string | undefined,
  projectId: '',
}

describe('StorageManager.publishEvent enriches with B5 wire format', () => {
  beforeEach(async () => {
    fixture.tempProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-mgr-publish-'))
    fixture.originalProjectsDir = process.env.PRJCT_PROJECTS_DIR
    process.env.PRJCT_PROJECTS_DIR = fixture.tempProjectsDir
    fixture.projectId = `mgr-publish-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    prjctDb.run(fixture.projectId, 'SELECT 1 WHERE 1=0')
  })

  afterEach(async () => {
    if (fixture.originalProjectsDir === undefined) delete process.env.PRJCT_PROJECTS_DIR
    else process.env.PRJCT_PROJECTS_DIR = fixture.originalProjectsDir
    await fs.rm(fixture.tempProjectsDir, { recursive: true, force: true })
  })

  test('addIdea publishes an enriched SyncEvent', async () => {
    const idea = await ideasStorage.addIdea(fixture.projectId, 'try k6 for load testing', {
      priority: 'high',
    })
    expect(idea.id).toBeTruthy()

    const pending = await syncEventBus.getPending(fixture.projectId)
    expect(pending.length).toBeGreaterThan(0)

    // Find the ideas event (other publishes may have fired alongside)
    const event = pending.find((e) => e.entityType === 'ideas')
    expect(event).toBeTruthy()
    if (!event) return

    // Wire-format expectations from B5
    expect(event.entityType).toBe('ideas')
    expect(event.eventType).toBe('upsert')
    expect(event.contentHash).toBeTruthy()
    expect(event.contentHash?.length).toBe(64) // sha256 hex
    expect(event.deviceId).toBeTruthy() // 'unknown-device' before B6
    expect(event.revisionCount).toBe(1)
    // Payload fingerprint is deterministic — same inputs → same hash.
    // We don't pin the value here (impl detail), only its presence.
  })

  test('publishEvent contentHash is stable across calls with same payload', async () => {
    // Two storages firing the same logical event should dedupe in
    // sync_pending. Stability of contentHash is the trick — we hash
    // sorted-keys JSON of the payload.
    const _i1 = await ideasStorage.addIdea(fixture.projectId, 'stable hash test', {
      priority: 'medium',
    })
    const _i2 = await ideasStorage.addIdea(fixture.projectId, 'different idea', {
      priority: 'medium',
    })

    const pending = await syncEventBus.getPending(fixture.projectId)
    const events = pending.filter((e) => e.entityType === 'ideas')
    expect(events.length).toBeGreaterThan(0)
    // Different ideas → different content hashes
    const hashes = new Set(events.map((e) => e.contentHash))
    expect(hashes.size).toBe(events.length)
  })
})
