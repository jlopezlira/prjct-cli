/**
 * Multi-workspace task overview — the observable read side. Asserts that the
 * main currentTask and child-worktree activeTasks[] are merged into one
 * labelled, current-marked list (the output contract), driven off a real DB.
 *
 * `current` is resolved from the caller's projectPath. In tests the path is a
 * plain temp dir (not a git worktree) so it derives to the `main` sentinel —
 * which is exactly the single-agent / main-worktree case.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'
import type { WorkspaceTask } from '../../schemas/state'
import { collectActiveTasks, formatActiveTaskList } from '../../services/task-overview'
import { prjctDb } from '../../storage/database'
import { stateStorage } from '../../storage/state-storage'
import { patchPathManager, restorePathManager } from '../_setup/path-manager-mock'

const fixture: {
  tmpRoot: string | null
  projectId: string
  projectPath: string
} = {
  tmpRoot: null,
  projectId: '',
  projectPath: '',
}

beforeEach(async () => {
  fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-overview-'))
  fixture.projectId = `test-ov-${Date.now()}`
  fixture.projectPath = path.join(fixture.tmpRoot, 'work') // plain dir → main sentinel
  await fs.mkdir(fixture.projectPath, { recursive: true })
  patchPathManager(fixture.tmpRoot!)
  await fs.mkdir(pathManager.getStoragePath(fixture.projectId, ''), { recursive: true })
  await fs.mkdir(path.join(fixture.tmpRoot!, fixture.projectId, 'sync'), { recursive: true })
})

afterEach(async () => {
  prjctDb.close()
  restorePathManager()
  if (fixture.tmpRoot) {
    await fs.rm(fixture.tmpRoot, { recursive: true, force: true })
    fixture.tmpRoot = null
  }
})

describe('collectActiveTasks', () => {
  it('empty → no current, empty list', async () => {
    const ov = await collectActiveTasks(fixture.projectId, fixture.projectPath)
    expect(ov.current).toBeNull()
    expect(ov.all).toHaveLength(0)
    expect(formatActiveTaskList(ov)).toBe('No active work cycle.')
  })

  it('main currentTask is the current workspace; child tasks are listed as others', async () => {
    await stateStorage.startTask(fixture.projectId, {
      id: 'main-1',
      description: 'main work',
      sessionId: 's-main',
    } as Parameters<typeof stateStorage.startTask>[1])
    await stateStorage.startTaskInWorkspace(
      fixture.projectId,
      {
        id: 'child-1',
        description: 'child work',
        sessionId: 's-child',
        workspaceId: 'ws-child',
        branch: 'feat/x',
      } as Omit<WorkspaceTask, 'startedAt'>,
      'ws-child'
    )

    const ov = await collectActiveTasks(fixture.projectId, fixture.projectPath)
    expect(ov.current?.id).toBe('main-1')
    expect(ov.current?.isCurrent).toBe(true)
    expect(ov.all).toHaveLength(2)

    const child = ov.all.find((v) => v.id === 'child-1')!
    expect(child.isCurrent).toBe(false)
    expect(child.shortId).toBe('ws-chi')
    expect(child.label).toBe('ws-chi · feat/x')

    // Current-first ordering + multi-workspace list rendering.
    expect(ov.all[0]!.isCurrent).toBe(true)
    const rendered = formatActiveTaskList(ov)
    expect(rendered).toContain('Active work cycles (2)')
    expect(rendered).toContain('(this worktree)')
  })
})
