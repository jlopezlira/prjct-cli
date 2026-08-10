/**
 * Per-record origin vs ingestion timestamps (migration 36).
 *
 * Two contracts to pin for the cross-machine data model:
 *   1. created_at = ORIGIN authored time. When an inbound event carries
 *      created_at, applyEvent persists it verbatim into the side table —
 *      it is NEVER replaced with the receiver's local clock.
 *   2. synced_at = INGESTION time on THIS machine (the locally stamped
 *      applied_at), distinct from created_at.
 *   3. A producer that omits created_at forces the receiver to lose
 *      origin chronology — applyEvent warns once per entity_type so the
 *      gap surfaces instead of silently corrupting the timeline.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'
import prjctDb from '../../storage/database'
import { getRecordMeta } from '../../sync/sync-applied-hashes'
import { _resetWarnDedupeForTest, syncManager } from '../../sync/sync-manager'

const fixture: {
  projectId: string
  originalProjectsDir: string | undefined
  warnCalls: string[]
  originalWarn: typeof console.warn
} = {
  projectId: '',
  originalProjectsDir: undefined as unknown as string | undefined,
  warnCalls: undefined as unknown as string[],
  originalWarn: undefined as unknown as typeof console.warn,
}

beforeEach(async () => {
  prjctDb.close()
  const tempProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-record-meta-'))
  fixture.originalProjectsDir = process.env.PRJCT_PROJECTS_DIR
  process.env.PRJCT_PROJECTS_DIR = tempProjectsDir
  fixture.projectId = `meta-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await pathManager.ensureProjectStructure(fixture.projectId)
  prjctDb.run(fixture.projectId, 'SELECT 1 WHERE 1=0')

  fixture.warnCalls = []
  fixture.originalWarn = console.warn
  console.warn = (...args: unknown[]) => {
    fixture.warnCalls.push(args.map((a) => String(a)).join(' '))
  }
  _resetWarnDedupeForTest()
})

afterEach(() => {
  console.warn = fixture.originalWarn
  _resetWarnDedupeForTest()
  if (fixture.originalProjectsDir === undefined) delete process.env.PRJCT_PROJECTS_DIR
  else process.env.PRJCT_PROJECTS_DIR = fixture.originalProjectsDir
  prjctDb.close()
})

async function applyEvent(event: Record<string, unknown>): Promise<void> {
  await (
    syncManager as unknown as {
      applyEvent: (pid: string, ev: Record<string, unknown>) => Promise<void>
    }
  ).applyEvent(fixture.projectId, event)
}

describe('per-record origin vs ingestion timestamps', () => {
  test('preserves origin created_at and stamps a distinct local synced_at', async () => {
    const origin = '2020-01-01T00:00:00.000Z'
    await applyEvent({
      entity_type: 'tasks',
      event_type: 'upsert',
      content_hash: 'hash-task-1',
      data: { id: 'task-1', description: 'from machine A', created_at: origin },
    })

    const meta = getRecordMeta(fixture.projectId, 'tasks', 'task-1')
    expect(meta).not.toBeNull()
    // Origin time survives the round trip verbatim — not overwritten.
    expect(meta?.createdAt).toBe(origin)
    // Ingestion time is the local apply time, clearly NOT the 2020 origin.
    expect(meta?.syncedAt).not.toBe(origin)
    expect(new Date(meta?.syncedAt ?? '').getFullYear()).toBeGreaterThan(2020)
  })

  test('accepts camelCase createdAt from the wire too', async () => {
    const origin = '2021-05-05T12:00:00.000Z'
    await applyEvent({
      entity_type: 'tasks',
      event_type: 'upsert',
      content_hash: 'hash-task-2',
      data: { id: 'task-2', description: 'camel', createdAt: origin },
    })

    expect(getRecordMeta(fixture.projectId, 'tasks', 'task-2')?.createdAt).toBe(origin)
  })

  test('warns once per entity_type when the producer omits created_at', async () => {
    await applyEvent({
      entity_type: 'tasks',
      event_type: 'upsert',
      content_hash: 'hash-task-3',
      data: { id: 'task-3', description: 'no origin' },
    })
    await applyEvent({
      entity_type: 'tasks',
      event_type: 'upsert',
      content_hash: 'hash-task-4',
      data: { id: 'task-4', description: 'still no origin' },
    })

    const missing = fixture.warnCalls.filter((w) => w.includes('missing_origin_created_at'))
    expect(missing.length).toBe(1)
    // No origin recorded — created_at stays null rather than a faked local now().
    expect(getRecordMeta(fixture.projectId, 'tasks', 'task-3')?.createdAt).toBeNull()
  })

  test('a later origin-less update does not blank an already-recorded created_at', async () => {
    const origin = '2019-09-09T09:09:09.000Z'
    await applyEvent({
      entity_type: 'tasks',
      event_type: 'upsert',
      content_hash: 'hash-task-5a',
      data: { id: 'task-5', description: 'v1', created_at: origin },
    })
    // Same entity, new content_hash, but the payload omits created_at.
    await applyEvent({
      entity_type: 'tasks',
      event_type: 'upsert',
      content_hash: 'hash-task-5b',
      data: { id: 'task-5', description: 'v2 edited elsewhere' },
    })

    expect(getRecordMeta(fixture.projectId, 'tasks', 'task-5')?.createdAt).toBe(origin)
  })
})
