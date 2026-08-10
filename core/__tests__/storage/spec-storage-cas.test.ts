/**
 * `specStorage.casUpdate` — optimistic-concurrency UPDATE on `specs.content`.
 *
 * The contract under test (spec a50b32d1 AC #12):
 *   - Returns `true` when the row's `updated_at` still matches the
 *     `expectedUpdatedAt` passed in (rows-affected === 1).
 *   - Returns `false` when somebody else has written since (stale read).
 *   - Preserves all SpecContent fields including the new `tasks_created_at`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import { specService } from '../../services/spec-service'
import prjctDb from '../../storage/database'
import { specStorage } from '../../storage/spec-storage'

const fixture: {
  projectPath: string
  projectId: string
  originalProjectsDir: string | undefined
} = {
  projectPath: '',
  projectId: '',
  originalProjectsDir: undefined as unknown as string | undefined,
}

async function freshProject(): Promise<void> {
  const tempProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-cas-pd-'))
  fixture.originalProjectsDir = process.env.PRJCT_PROJECTS_DIR
  process.env.PRJCT_PROJECTS_DIR = tempProjectsDir

  fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-cas-'))
  await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
  fixture.projectId = `cas-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await configManager.writeConfig(fixture.projectPath, {
    projectId: fixture.projectId,
    dataPath: path.join(fixture.projectPath, '.prjct-data'),
  } as Parameters<typeof configManager.writeConfig>[1])
  await pathManager.ensureProjectStructure(fixture.projectId)
  prjctDb.run(fixture.projectId, 'SELECT 1 WHERE 1=0')
}

beforeEach(async () => {
  prjctDb.close()
  await freshProject()
})

afterEach(async () => {
  if (fixture.originalProjectsDir === undefined) delete process.env.PRJCT_PROJECTS_DIR
  else process.env.PRJCT_PROJECTS_DIR = fixture.originalProjectsDir
  if (fixture.projectPath)
    await fs.rm(fixture.projectPath, { recursive: true, force: true }).catch(() => {})
  prjctDb.close()
})

describe('specStorage.casUpdate', () => {
  test('succeeds when updated_at matches (returns true)', async () => {
    const created = await specService.create(fixture.projectPath, {
      title: 'cas-test',
      content: { goal: 'test CAS happy path' },
      autoContext: false,
    })
    const fresh = specStorage.get(fixture.projectId, created.id)
    expect(fresh).not.toBeNull()
    const original = fresh!

    const ok = specStorage.casUpdate(
      fixture.projectId,
      created.id,
      { ...original.content, eli10: 'updated via CAS' },
      original.updatedAt
    )
    expect(ok).toBe(true)

    const after = specStorage.get(fixture.projectId, created.id)
    expect(after?.content.eli10).toBe('updated via CAS')
    expect(after?.content.goal).toBe('test CAS happy path')
    // updated_at is now STRICTLY monotonic per write (specStorage
    // .nextUpdatedAt forces it greater than the row's current stamp so
    // the CAS token can't collide at sub-millisecond write rates).
    expect(after?.updatedAt).not.toBe(original.updatedAt)
    expect((after?.updatedAt ?? '') > original.updatedAt).toBe(true)
  })

  test('rejects stale write (returns false) when updated_at has moved', async () => {
    const created = await specService.create(fixture.projectPath, {
      title: 'cas-stale',
      content: { goal: 'test CAS stale read' },
      autoContext: false,
    })
    const original = specStorage.get(fixture.projectId, created.id)!
    // Bump updated_at via a legitimate write so the CAS' expected
    // matches the snapshot but not the current row.
    specStorage.updateContent(fixture.projectId, created.id, {
      ...original.content,
      eli10: 'someone-else',
    })

    const ok = specStorage.casUpdate(
      fixture.projectId,
      created.id,
      { ...original.content, eli10: 'stale writer' },
      original.updatedAt
    )
    expect(ok).toBe(false)

    // The "someone-else" write must still be the latest.
    const after = specStorage.get(fixture.projectId, created.id)
    expect(after?.content.eli10).toBe('someone-else')
  })

  test('preserves tasks_created_at across a CAS write', async () => {
    const created = await specService.create(fixture.projectPath, {
      title: 'cas-tasks-marker',
      content: { goal: 'preserve completion marker through CAS' },
      autoContext: false,
    })
    // Plant a tasks_created_at marker the way breakdownSpecToTasks does.
    const original = specStorage.get(fixture.projectId, created.id)!
    const markedAt = '2026-05-14T00:00:00.000Z'
    specStorage.updateContent(fixture.projectId, created.id, {
      ...original.content,
      tasks_created_at: markedAt,
    })
    const withMarker = specStorage.get(fixture.projectId, created.id)!

    // CAS another field without touching the marker.
    const ok = specStorage.casUpdate(
      fixture.projectId,
      created.id,
      { ...withMarker.content, stakes: 'higher than expected' },
      withMarker.updatedAt
    )
    expect(ok).toBe(true)

    const after = specStorage.get(fixture.projectId, created.id)
    expect(after?.content.tasks_created_at).toBe(markedAt)
    expect(after?.content.stakes).toBe('higher than expected')
  })
})
