/**
 * Archives handler — pulled `archives` events reconstruct the full local
 * archive row (entity_data included) and dedupe by the archived pair.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'
import prjctDb from '../../storage/database'
import { archivesHandler } from '../../sync/entity-handlers/archives'

const fixture: {
  projectId: string
  originalProjectsDir: string | undefined
} = {
  projectId: '',
  originalProjectsDir: undefined as unknown as string | undefined,
}

beforeEach(async () => {
  prjctDb.close()
  const tempProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-archives-h-'))
  fixture.originalProjectsDir = process.env.PRJCT_PROJECTS_DIR
  process.env.PRJCT_PROJECTS_DIR = tempProjectsDir
  fixture.projectId = `arch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await pathManager.ensureProjectStructure(fixture.projectId)
  prjctDb.run(fixture.projectId, 'SELECT 1 WHERE 1=0')
})

afterEach(() => {
  if (fixture.originalProjectsDir === undefined) delete process.env.PRJCT_PROJECTS_DIR
  else process.env.PRJCT_PROJECTS_DIR = fixture.originalProjectsDir
  prjctDb.close()
})

function getArchive(entityType: string, entityId: string) {
  return prjctDb.get<{
    id: string
    entity_data: string
    archived_at: string
    reason: string
  }>(
    fixture.projectId,
    'SELECT id, entity_data, archived_at, reason FROM archives WHERE entity_type = ? AND entity_id = ?',
    entityType,
    entityId
  )
}

describe('archivesHandler', () => {
  test('reconstructs the full archived row from a pulled event', async () => {
    await archivesHandler.upsert(fixture.projectId, {
      id: 'archive-row-1',
      entity_type: 'shipped',
      entity_id: 'ship-9',
      entity_data: JSON.stringify({ name: 'feature X', version: '1.2.3' }),
      summary: 'feature X v1.2.3',
      reason: 'age',
      archived_at: '2020-06-01T00:00:00.000Z',
      created_at: '2020-06-01T00:00:00.000Z',
    })

    const row = getArchive('shipped', 'ship-9')
    expect(row).not.toBeNull()
    expect(row?.archived_at).toBe('2020-06-01T00:00:00.000Z')
    expect(row?.reason).toBe('age')
    // entity_data survived as the full payload, not a lossy stub.
    expect(JSON.parse(row?.entity_data ?? '{}')).toEqual({ name: 'feature X', version: '1.2.3' })
  })

  test('dedupes by archived (entity_type, entity_id), not the per-machine id', async () => {
    await archivesHandler.upsert(fixture.projectId, {
      id: 'id-from-machine-A',
      entity_type: 'idea',
      entity_id: 'idea-1',
      entity_data: JSON.stringify({ title: 'original' }),
      reason: 'dormant',
      archived_at: '2021-01-01T00:00:00.000Z',
    })
    // Same archived entity, different per-machine archive id — must not dup.
    await archivesHandler.upsert(fixture.projectId, {
      id: 'id-from-machine-B',
      entity_type: 'idea',
      entity_id: 'idea-1',
      entity_data: JSON.stringify({ title: 'should be ignored' }),
      reason: 'dormant',
      archived_at: '2021-02-02T00:00:00.000Z',
    })

    const rows = prjctDb.query<{ id: string }>(
      fixture.projectId,
      'SELECT id FROM archives WHERE entity_type = ? AND entity_id = ?',
      'idea',
      'idea-1'
    )
    expect(rows.length).toBe(1)
    expect(rows[0]?.id).toBe('id-from-machine-A')
  })

  test('delete is a no-op (sync never removes a local archive)', async () => {
    await archivesHandler.upsert(fixture.projectId, {
      id: 'a1',
      entity_type: 'queue_task',
      entity_id: 'q-1',
      entity_data: '{}',
      reason: 'age',
      archived_at: '2022-01-01T00:00:00.000Z',
    })
    await archivesHandler.delete(fixture.projectId, { entity_type: 'queue_task', entity_id: 'q-1' })
    expect(getArchive('queue_task', 'q-1')).not.toBeNull()
  })
})
