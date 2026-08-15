/**
 * breakdownSpecToTasks — partial-recovery via `tasks_created_at` marker
 * + reconcile-by-adoption.
 *
 * The contract under test (spec a50b32d1 AC #13):
 *   - Marker set ⇒ early return (no double-create on re-entry).
 *   - Marker null AND linked_tasks non-empty ⇒ partial-breakdown detected;
 *     recovery RECONCILES: each AC adopts the existing queue row with
 *     matching body (featureId = spec.id) — id and completion state
 *     intact — and only ACs without a surviving row are created. Final
 *     state: all ACs as tasks, marker set, no duplicates.
 *   - Marker null AND linked_tasks empty ⇒ fresh breakdown.
 *
 * Convergence proof: marker is set ONLY after the full loop completes,
 * so any crash leaves marker=null + (possibly partial) linked_tasks and
 * the next caller re-runs the recovery. This test simulates a crash by
 * leaving the state inconsistent manually, then re-invokes breakdown.
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
  const tempProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-pbr-pd-'))
  fixture.originalProjectsDir = process.env.PRJCT_PROJECTS_DIR
  process.env.PRJCT_PROJECTS_DIR = tempProjectsDir

  fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-pbr-'))
  await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
  fixture.projectId = `pbr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
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

describe('breakdownSpecToTasks partial-recovery', () => {
  test('fresh breakdown: creates one task per AC + sets marker', async () => {
    const spec = await specService.create(fixture.projectPath, {
      title: 'fresh-breakdown',
      content: {
        goal: 'three criteria',
        acceptance_criteria: ['ac1', 'ac2', 'ac3'],
      },
      autoContext: false,
    })

    const result = await breakdownSpecToTasks(fixture.projectId, fixture.projectPath, spec)
    expect(result.taskIds).toHaveLength(3)
    expect(result.recoveredFromPartial).toBeUndefined()

    const after = specStorage.get(fixture.projectId, spec.id)!
    expect(after.content.tasks_created_at).not.toBeNull()
    expect(after.content.linked_tasks).toHaveLength(3)

    const queued = await queueStorage.getTasks(fixture.projectId)
    expect(queued.filter((t) => t.featureId === spec.id)).toHaveLength(3)
  })

  test('re-entry on a completed spec is a no-op (marker guards it)', async () => {
    const spec = await specService.create(fixture.projectPath, {
      title: 'idempotent-re-entry',
      content: {
        goal: 'two criteria',
        acceptance_criteria: ['ac1', 'ac2'],
      },
      autoContext: false,
    })
    const first = await breakdownSpecToTasks(fixture.projectId, fixture.projectPath, spec)
    expect(first.taskIds).toHaveLength(2)

    const refreshed = specStorage.get(fixture.projectId, spec.id)!
    const second = await breakdownSpecToTasks(fixture.projectId, fixture.projectPath, refreshed)
    expect(second.taskIds).toHaveLength(0)
    expect(second.skippedReason).toBe('already_broken_down')

    const queued = await queueStorage.getTasks(fixture.projectId)
    expect(queued.filter((t) => t.featureId === spec.id)).toHaveLength(2)
  })

  test('partial breakdown (marker null + linked_tasks non-empty) is recovered via adoption', async () => {
    // Simulate a crash MID-LOOP: we'll create the spec, run a full
    // breakdown, then manually clear the marker AND truncate linked_tasks
    // to imitate the partial state.
    const spec = await specService.create(fixture.projectPath, {
      title: 'partial-breakdown',
      content: {
        goal: 'five criteria',
        acceptance_criteria: ['ac1', 'ac2', 'ac3', 'ac4', 'ac5'],
      },
      autoContext: false,
    })

    const first = await breakdownSpecToTasks(fixture.projectId, fixture.projectPath, spec)
    expect(first.taskIds).toHaveLength(5)

    // Force partial-state shape: marker=null AND linked_tasks
    // intentionally truncated to 2 of 5 (the crash window). The 5 queue
    // rows survive and must be ADOPTED, not wiped + recreated.
    const baseline = specStorage.get(fixture.projectId, spec.id)!
    specStorage.updateContent(fixture.projectId, spec.id, {
      ...baseline.content,
      tasks_created_at: null,
      linked_tasks: baseline.content.linked_tasks.slice(0, 2),
    })

    // Sanity: queue still has 5 rows tagged with this featureId before
    // the recovery.
    const before = await queueStorage.getTasks(fixture.projectId)
    expect(before.filter((t) => t.featureId === spec.id)).toHaveLength(5)

    const partial = specStorage.get(fixture.projectId, spec.id)!
    const second = await breakdownSpecToTasks(fixture.projectId, fixture.projectPath, partial)
    expect(second.recoveredFromPartial).toBe(true)
    expect(second.taskIds).toHaveLength(5)

    // Adoption, not recreation: the same task ids come back, in AC order.
    expect(second.taskIds).toEqual(first.taskIds)

    // After recovery: queue carries exactly 5 (no duplicates from the
    // pre-recovery rows), spec.linked_tasks is full again, marker is set.
    const after = specStorage.get(fixture.projectId, spec.id)!
    expect(after.content.tasks_created_at).not.toBeNull()
    expect(after.content.linked_tasks).toHaveLength(5)

    const queued = await queueStorage.getTasks(fixture.projectId)
    expect(queued.filter((t) => t.featureId === spec.id)).toHaveLength(5)
  })
})
