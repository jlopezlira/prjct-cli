/**
 * Per-workspace task isolation + gating (multi-agent parallel mode).
 *
 * Exercises the storage layer that the CLI/MCP write path now routes through
 * for child worktrees: each workspaceId owns its slot in activeTasks[], the
 * single-task gate is evaluated per workspace, and a main-worktree currentTask
 * never leaks into a child workspace's lifecycle.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'
import type { WorkspaceTask } from '../../schemas/state'
import { prjctDb } from '../../storage/database'
import { stateStorage } from '../../storage/state-storage'
import { patchPathManager, restorePathManager } from '../_setup/path-manager-mock'

const fixture: {
  tmpRoot: string | null
  projectId: string
} = {
  tmpRoot: null,
  projectId: '',
}

beforeEach(async () => {
  fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-ws-gate-'))
  fixture.projectId = `test-ws-${Date.now()}`
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

const task = (id: string, wsId: string): Omit<WorkspaceTask, 'startedAt'> =>
  ({
    id,
    description: `task ${id}`,
    sessionId: `sess-${id}`,
    workspaceId: wsId,
  }) as Omit<WorkspaceTask, 'startedAt'>

describe('per-workspace gate + isolation', () => {
  it('two workspaces can each hold an active task concurrently', async () => {
    await stateStorage.startTaskInWorkspace(fixture.projectId, task('a', 'ws-a'), 'ws-a')
    await stateStorage.startTaskInWorkspace(fixture.projectId, task('b', 'ws-b'), 'ws-b')

    const active = await stateStorage.getActiveTasks(fixture.projectId)
    expect(active.map((t) => t.workspaceId).sort()).toEqual(['ws-a', 'ws-b'])
  })

  it('a second task in the SAME workspace is gated', async () => {
    await stateStorage.startTaskInWorkspace(fixture.projectId, task('a', 'ws-a'), 'ws-a')
    await expect(
      stateStorage.startTaskInWorkspace(fixture.projectId, task('a2', 'ws-a'), 'ws-a')
    ).rejects.toThrow()
  })

  it('a main-worktree currentTask does NOT block a child workspace', async () => {
    await stateStorage.startTask(fixture.projectId, {
      id: 'main',
      description: 'main task',
      sessionId: 'sess-main',
    } as Parameters<typeof stateStorage.startTask>[1])

    // Should not throw — the child workspace is independent of currentTask.
    await stateStorage.startTaskInWorkspace(fixture.projectId, task('a', 'ws-a'), 'ws-a')
    const wsTask = await stateStorage.getCurrentTaskForWorkspace(fixture.projectId, 'ws-a')
    expect(wsTask?.id).toBe('a')
  })

  it('addTokens accumulates against the named workspace only', async () => {
    await stateStorage.startTaskInWorkspace(fixture.projectId, task('a', 'ws-a'), 'ws-a')
    await stateStorage.startTaskInWorkspace(fixture.projectId, task('b', 'ws-b'), 'ws-b')

    await stateStorage.addTokens(fixture.projectId, 10, 5, 'ws-a')
    const r = await stateStorage.addTokens(fixture.projectId, 3, 2, 'ws-a')
    expect(r).toEqual({ tokensIn: 13, tokensOut: 7 })

    const a = await stateStorage.getCurrentTaskForWorkspace(fixture.projectId, 'ws-a')
    const b = await stateStorage.getCurrentTaskForWorkspace(fixture.projectId, 'ws-b')
    expect(a?.tokensIn).toBe(13)
    expect(b?.tokensIn ?? 0).toBe(0) // ws-b untouched
  })

  it('updateWorkspaceTask merges by workspaceId', async () => {
    await stateStorage.startTaskInWorkspace(fixture.projectId, task('a', 'ws-a'), 'ws-a')
    const updated = await stateStorage.updateWorkspaceTask(fixture.projectId, 'ws-a', {
      type: 'bug',
    })
    expect(updated?.type).toBe('bug')
    expect((await stateStorage.getCurrentTaskForWorkspace(fixture.projectId, 'ws-a'))?.type).toBe(
      'bug'
    )
  })

  it('completing one workspace leaves the others untouched', async () => {
    await stateStorage.startTaskInWorkspace(fixture.projectId, task('a', 'ws-a'), 'ws-a')
    await stateStorage.startTaskInWorkspace(fixture.projectId, task('b', 'ws-b'), 'ws-b')

    await stateStorage.completeTaskInWorkspace(fixture.projectId, 'ws-a')

    expect(await stateStorage.getCurrentTaskForWorkspace(fixture.projectId, 'ws-a')).toBeNull()
    expect((await stateStorage.getCurrentTaskForWorkspace(fixture.projectId, 'ws-b'))?.id).toBe('b')
    // After completing its task, the workspace is idle → can start again.
    await stateStorage.startTaskInWorkspace(fixture.projectId, task('a3', 'ws-a'), 'ws-a')
    expect((await stateStorage.getCurrentTaskForWorkspace(fixture.projectId, 'ws-a'))?.id).toBe(
      'a3'
    )
  })
})
