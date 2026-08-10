/**
 * End-to-end workspace routing for the read/complete helpers used by
 * `prjct ship` and `prjct status`. Combines a REAL git worktree (so
 * deriveWorkspace resolves a child workspaceId from the path) with a mocked
 * storage path (so state persists under a temp projectId). Proves that
 * resolveActiveTask / completeActiveTask target the worktree's own task.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { exec } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import pathManager from '../../infrastructure/path-manager'
import type { WorkspaceTask } from '../../schemas/state'
import { completeActiveTask, resolveActiveTask, setTaskStatus } from '../../services/task-service'
import { deriveWorkspace } from '../../services/workspace-id'
import { prjctDb } from '../../storage/database'
import { stateStorage } from '../../storage/state-storage'
import { patchPathManager, restorePathManager } from '../_setup/path-manager-mock'

const execAsync = promisify(exec)

const fixture: {
  tmpRoot: string
  mainRepo: string
  wt: string
  projectId: string
} = {
  tmpRoot: '',
  mainRepo: '',
  wt: '',
  projectId: '',
}

beforeEach(async () => {
  fixture.tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-tsw-')))
  fixture.projectId = `test-tsw-${Date.now()}`
  patchPathManager(fixture.tmpRoot)
  await fs.mkdir(pathManager.getStoragePath(fixture.projectId, ''), { recursive: true })
  await fs.mkdir(path.join(fixture.tmpRoot, fixture.projectId, 'sync'), { recursive: true })

  fixture.mainRepo = path.join(fixture.tmpRoot, 'repo')
  await fs.mkdir(fixture.mainRepo, { recursive: true })
  const git = (c: string, cwd: string) => execAsync(`git ${c}`, { cwd })
  await git('init -q', fixture.mainRepo)
  await git('config user.email t@t.io', fixture.mainRepo)
  await git('config user.name t', fixture.mainRepo)
  await fs.writeFile(path.join(fixture.mainRepo, 'f.txt'), 'x')
  await git('add -A', fixture.mainRepo)
  await git('commit -q -m init', fixture.mainRepo)
  fixture.wt = path.join(fixture.tmpRoot, 'wt')
  await git(`worktree add -q "${fixture.wt}" -b feat-wt`, fixture.mainRepo)
})

afterEach(async () => {
  prjctDb.close()
  restorePathManager()
  await fs.rm(fixture.tmpRoot, { recursive: true, force: true }).catch(() => {})
})

describe('resolve/completeActiveTask routing', () => {
  it('resolves the child worktree task, isolated from the main task', async () => {
    const ws = await deriveWorkspace(fixture.wt)
    expect(ws.isMain).toBe(false)

    // main task + this worktree's task
    await stateStorage.startTask(fixture.projectId, {
      id: 'main-1',
      description: 'main',
      sessionId: 's1',
    } as Parameters<typeof stateStorage.startTask>[1])
    await stateStorage.startTaskInWorkspace(
      fixture.projectId,
      {
        id: 'wt-1',
        description: 'wt work',
        sessionId: 's2',
        workspaceId: ws.workspaceId,
        linkedSpecId: 'spec-xyz',
      } as Omit<WorkspaceTask, 'startedAt'>,
      ws.workspaceId
    )

    // From the worktree path → the worktree's task (with its spec linkage).
    const fromWt = await resolveActiveTask(fixture.projectId, fixture.wt)
    expect(fromWt?.id).toBe('wt-1')
    expect(fromWt?.linkedSpecId).toBe('spec-xyz')

    // From the main repo path → the main task.
    const fromMain = await resolveActiveTask(fixture.projectId, fixture.mainRepo)
    expect(fromMain?.id).toBe('main-1')
  })

  it('completing from the worktree removes only the worktree task', async () => {
    const ws = await deriveWorkspace(fixture.wt)
    await stateStorage.startTask(fixture.projectId, {
      id: 'main-1',
      description: 'main',
      sessionId: 's1',
    } as Parameters<typeof stateStorage.startTask>[1])
    await stateStorage.startTaskInWorkspace(
      fixture.projectId,
      {
        id: 'wt-1',
        description: 'wt work',
        sessionId: 's2',
        workspaceId: ws.workspaceId,
      } as Omit<WorkspaceTask, 'startedAt'>,
      ws.workspaceId
    )

    const done = await completeActiveTask(fixture.projectId, fixture.wt)
    expect(done?.id).toBe('wt-1')
    expect(await resolveActiveTask(fixture.projectId, fixture.wt)).toBeNull()
    // Main task untouched.
    expect((await resolveActiveTask(fixture.projectId, fixture.mainRepo))?.id).toBe('main-1')
  })

  it('setTaskStatus: done completes the worktree task; paused is unsupported (no false success)', async () => {
    const ws = await deriveWorkspace(fixture.wt)
    await stateStorage.startTaskInWorkspace(
      fixture.projectId,
      {
        id: 'wt-1',
        description: 'wt work',
        sessionId: 's2',
        workspaceId: ws.workspaceId,
      } as Omit<WorkspaceTask, 'startedAt'>,
      ws.workspaceId
    )

    // paused/active not yet supported per-worktree → explicit unsupported,
    // NOT a false ok that would leave the task wedged.
    const paused = await setTaskStatus(fixture.projectId, fixture.wt, 'paused')
    expect(paused.ok).toBe(false)
    if (!paused.ok) expect(paused.reason).toBe('unsupported')
    // Task is still active (not mutated by the failed pause).
    expect((await resolveActiveTask(fixture.projectId, fixture.wt))?.id).toBe('wt-1')

    // done works and clears it.
    const done = await setTaskStatus(fixture.projectId, fixture.wt, 'done')
    expect(done.ok).toBe(true)
    expect(await resolveActiveTask(fixture.projectId, fixture.wt)).toBeNull()
  })
})
