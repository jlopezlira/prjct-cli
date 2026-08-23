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
import { archiveStorage } from '../../storage/archive-storage'
import { prjctDb } from '../../storage/database'
import { stateStorage } from '../../storage/state-storage'
import { execFileAsync } from '../../utils/exec'
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

describe('zombie workspace-task sweep', () => {
  const startWsTask = (
    id: string,
    workspaceId: string,
    description: string,
    worktreePath?: string
  ) =>
    stateStorage.startTaskInWorkspace(
      fixture.projectId,
      {
        id,
        description,
        sessionId: `s-${id}`,
        workspaceId,
        worktreePath,
      } as Omit<WorkspaceTask, 'startedAt'>,
      workspaceId
    )

  it('archives entries whose worktree path is gone; keeps live and path-less ones', async () => {
    // Real git repo with one live worktree — the sweep's only source of truth.
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: fixture.projectPath })
    await execFileAsync('git', ['config', 'user.email', 't@example.com'], {
      cwd: fixture.projectPath,
    })
    await execFileAsync('git', ['config', 'user.name', 'Tester'], { cwd: fixture.projectPath })
    await execFileAsync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], {
      cwd: fixture.projectPath,
    })
    const livePath = path.join(fixture.tmpRoot!, 'live-wt')
    await execFileAsync('git', ['worktree', 'add', '-q', '-b', 'feat/live', livePath], {
      cwd: fixture.projectPath,
    })

    await startWsTask('live-1', 'ws-live', 'live work', await fs.realpath(livePath))
    await startWsTask('gone-1', 'ws-gone', 'gone work', path.join(fixture.tmpRoot!, 'gone-wt'))
    await startWsTask('legacy-1', 'ws-legacy', 'no worktreePath recorded')

    const ov = await collectActiveTasks(fixture.projectId, fixture.projectPath)
    expect(ov.all.map((v) => v.id).sort()).toEqual(['legacy-1', 'live-1'])

    // Removal is persisted, and the zombie landed in the archive table.
    const remaining = await stateStorage.getActiveTasks(fixture.projectId)
    expect(remaining.map((t) => t.id).sort()).toEqual(['legacy-1', 'live-1'])
    const archived = archiveStorage.getArchived(fixture.projectId, 'workspace_task')
    expect(archived).toHaveLength(1)
    expect(archived[0]!.summary).toBe('gone work')
    expect(archived[0]!.reason).toBe('staleness')
  })

  it('fail-soft: not a git repo → list untouched even when the path is gone', async () => {
    // fixture.projectPath is a plain tmp dir (no git) → git spawn fails → keep.
    await startWsTask('gone-1', 'ws-gone', 'gone work', path.join(fixture.tmpRoot!, 'gone-wt'))

    const ov = await collectActiveTasks(fixture.projectId, fixture.projectPath)
    expect(ov.all.map((v) => v.id)).toEqual(['gone-1'])
    expect(archiveStorage.getArchived(fixture.projectId, 'workspace_task')).toHaveLength(0)
  })
})

describe('a finished cycle is not an active one', () => {
  // `currentTask` is a pointer with no status of its own, and closing a cycle
  // does not clear it — so every consumer kept announcing
  // "Active work cycle: <finished cycle>" while `prjct prime`, reading the
  // real status, said "No open cycle". Two prjct surfaces disagreeing about
  // whether the user has work in flight.
  const startMain = async (id: string) =>
    stateStorage.startTask(fixture.projectId, {
      id,
      description: 'closed work',
      sessionId: 's-done',
    } as Parameters<typeof stateStorage.startTask>[1])

  it('drops the main cycle from the active view once its row is completed', async () => {
    await startMain('done-1')
    expect((await collectActiveTasks(fixture.projectId, fixture.projectPath)).current?.id).toBe(
      'done-1'
    )

    prjctDb.run(
      fixture.projectId,
      "UPDATE tasks SET status = 'completed', completed_at = ? WHERE id = ?",
      new Date().toISOString(),
      'done-1'
    )

    const ov = await collectActiveTasks(fixture.projectId, fixture.projectPath)
    expect(ov.current).toBeNull()
    expect(ov.all).toHaveLength(0)
    expect(formatActiveTaskList(ov)).toBe('No active work cycle.')
  })

  it('still exposes the raw pointer, which callers use for turn counters', async () => {
    await startMain('done-2')
    prjctDb.run(
      fixture.projectId,
      "UPDATE tasks SET status = 'completed', completed_at = ? WHERE id = ?",
      new Date().toISOString(),
      'done-2'
    )
    const ov = await collectActiveTasks(fixture.projectId, fixture.projectPath)
    expect(ov.mainTaskRaw?.id).toBe('done-2')
  })

  it('keeps an in-progress cycle visible', async () => {
    await startMain('live-1')
    const ov = await collectActiveTasks(fixture.projectId, fixture.projectPath)
    expect(ov.current?.id).toBe('live-1')
  })
})
