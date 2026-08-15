/**
 * breakdownSpecToTasks — reconcile semantics (spec a50b32d1 AC #13).
 *
 * Re-breakdown (marker forced back to null) never wipes queue rows:
 *   - A queue row whose `body` matches an AC (featureId = spec.id) is
 *     ADOPTED — id and completion state survive intact.
 *   - An edited AC creates a NEW task; the old row stays in the queue as
 *     a visible, user-disposable orphan — never silently deleted.
 *   - The crash window between queue insert and link (marker null +
 *     linked_tasks empty + rows already in queue) converges by adoption
 *     instead of duplicating rows.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import { specService } from '../../services/spec-service'
import { breakdownSpecToTasks } from '../../services/spec-task-breakdown'
import prjctDb from '../../storage/database'
import { queueStorage } from '../../storage/queue-storage'
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
  const tempProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-rc-pd-'))
  fixture.originalProjectsDir = process.env.PRJCT_PROJECTS_DIR
  process.env.PRJCT_PROJECTS_DIR = tempProjectsDir

  fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-rc-'))
  await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
  fixture.projectId = `rc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
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

/** Force a spec back to "needs breakdown" (marker null), keeping the rest. */
function reopenBreakdown(specId: string, linkedTasks?: string[]): void {
  const current = specStorage.get(fixture.projectId, specId)!
  specStorage.updateContent(fixture.projectId, specId, {
    ...current.content,
    tasks_created_at: null,
    ...(linkedTasks ? { linked_tasks: linkedTasks } : {}),
  })
}

describe('breakdownSpecToTasks reconcile', () => {
  test('a completed task survives re-breakdown with status and id intact', async () => {
    const spec = await specService.create(fixture.projectPath, {
      title: 'reconcile-keeps-done',
      content: {
        goal: 'three criteria',
        acceptance_criteria: ['ac1', 'ac2', 'ac3'],
      },
      autoContext: false,
    })

    const first = await breakdownSpecToTasks(fixture.projectId, fixture.projectPath, spec)
    expect(first.taskIds).toHaveLength(3)

    const doneId = first.taskIds[1]
    const completed = await queueStorage.completeTask(fixture.projectId, doneId)
    expect(completed?.completed).toBe(true)

    reopenBreakdown(spec.id)
    const reopened = specStorage.get(fixture.projectId, spec.id)!
    const second = await breakdownSpecToTasks(fixture.projectId, fixture.projectPath, reopened)

    // All three rows adopted — same ids, in AC order, nothing recreated.
    expect(second.taskIds).toEqual(first.taskIds)

    const queued = await queueStorage.getTasks(fixture.projectId)
    const forSpec = queued.filter((t) => t.featureId === spec.id)
    expect(forSpec).toHaveLength(3)
    const survivor = forSpec.find((t) => t.id === doneId)!
    expect(survivor.completed).toBe(true)
    expect(survivor.completedAt).toBe(completed?.completedAt)

    const after = specStorage.get(fixture.projectId, spec.id)!
    expect(after.content.tasks_created_at).not.toBeNull()
    expect(after.content.linked_tasks).toHaveLength(3)
  })

  test('an edited AC creates a new task; the orphaned row stays in the queue', async () => {
    const spec = await specService.create(fixture.projectPath, {
      title: 'reconcile-edited-ac',
      content: {
        goal: 'two criteria',
        acceptance_criteria: ['ac1', 'ac2 original'],
      },
      autoContext: false,
    })

    const first = await breakdownSpecToTasks(fixture.projectId, fixture.projectPath, spec)
    expect(first.taskIds).toHaveLength(2)
    const [keptId, orphanedId] = first.taskIds

    // Edit AC #2 text and force re-breakdown.
    const current = specStorage.get(fixture.projectId, spec.id)!
    specStorage.updateContent(fixture.projectId, spec.id, {
      ...current.content,
      acceptance_criteria: ['ac1', 'ac2 edited'],
      tasks_created_at: null,
    })

    const reopened = specStorage.get(fixture.projectId, spec.id)!
    const second = await breakdownSpecToTasks(fixture.projectId, fixture.projectPath, reopened)

    // ac1's row is adopted; ac2 edited gets a brand-new task.
    expect(second.taskIds).toHaveLength(2)
    expect(second.taskIds[0]).toBe(keptId)
    expect(second.taskIds[1]).not.toBe(orphanedId)

    // The orphan is LEFT in the queue — visible, user-disposable.
    const queued = await queueStorage.getTasks(fixture.projectId)
    const forSpec = queued.filter((t) => t.featureId === spec.id)
    expect(forSpec).toHaveLength(3)
    expect(forSpec.map((t) => t.id)).toContain(orphanedId)
    const orphan = forSpec.find((t) => t.id === orphanedId)!
    expect(orphan.body).toBe('ac2 original')

    // Spec links the live tasks; the orphan's link lingers too (reconcile
    // never unlinks — the orphan stays visible for the user to dispose of).
    // Marker re-set.
    const after = specStorage.get(fixture.projectId, spec.id)!
    expect(after.content.linked_tasks).toEqual(
      expect.arrayContaining([...second.taskIds, orphanedId])
    )
    expect(after.content.tasks_created_at).not.toBeNull()
  })

  test('crash between queue insert and link (marker null + linked empty) adopts instead of duplicating', async () => {
    const spec = await specService.create(fixture.projectPath, {
      title: 'reconcile-crash-window',
      content: {
        goal: 'three criteria',
        acceptance_criteria: ['ac1', 'ac2', 'ac3'],
      },
      autoContext: false,
    })

    const first = await breakdownSpecToTasks(fixture.projectId, fixture.projectPath, spec)
    expect(first.taskIds).toHaveLength(3)

    // The old wipe-and-rerun orphan window: rows landed in the queue but
    // the crash hit before any linkTask, so linked_tasks reads empty and
    // the entry guard treats this as a FRESH breakdown.
    reopenBreakdown(spec.id, [])

    const reopened = specStorage.get(fixture.projectId, spec.id)!
    const second = await breakdownSpecToTasks(fixture.projectId, fixture.projectPath, reopened)
    expect(second.recoveredFromPartial).toBeUndefined()
    expect(second.taskIds).toEqual(first.taskIds)

    const queued = await queueStorage.getTasks(fixture.projectId)
    expect(queued.filter((t) => t.featureId === spec.id)).toHaveLength(3) // not 6

    const after = specStorage.get(fixture.projectId, spec.id)!
    expect(after.content.linked_tasks).toHaveLength(3)
    expect(after.content.tasks_created_at).not.toBeNull()
  })
})
