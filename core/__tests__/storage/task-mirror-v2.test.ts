/**
 * C4: the live work cycle is mirrored into the typed `tasks` table on
 * start/complete (dual-write), so it's queryable without parsing the kv_store
 * state doc. The kv_store state stays the live source for the work loop.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'
import { prjctDb } from '../../storage/database'
import { stateStorage } from '../../storage/state-storage'

const fixture: {
  tmpRoot: string
  projectId: string
} = {
  tmpRoot: '',
  projectId: '',
}

const orig = pathManager.getGlobalProjectPath.bind(pathManager)
const origStorage = pathManager.getStoragePath.bind(pathManager)
const origFile = pathManager.getFilePath.bind(pathManager)

beforeEach(async () => {
  fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-taskmirror-'))
  fixture.projectId = `taskmirror-${Date.now()}`
  pathManager.getGlobalProjectPath = (id: string) => path.join(fixture.tmpRoot, id)
  pathManager.getStoragePath = (id: string, f: string) =>
    path.join(fixture.tmpRoot, id, 'storage', f)
  pathManager.getFilePath = (id: string, layer: string, f: string) =>
    path.join(fixture.tmpRoot, id, layer, f)
  prjctDb.getDb(fixture.projectId)
})

afterEach(async () => {
  prjctDb.close()
  pathManager.getGlobalProjectPath = orig
  pathManager.getStoragePath = origStorage
  pathManager.getFilePath = origFile
  await fs.rm(fixture.tmpRoot, { recursive: true, force: true })
})

describe('task table mirror (C4)', () => {
  it('mirrors start + complete into the typed tasks table', async () => {
    await stateStorage.startTask(fixture.projectId, {
      id: 'task_abc',
      description: 'Wire up the thing',
      sessionId: 'sess_1',
      linkedSpecId: 'spec_9',
    })

    const startedRow = prjctDb.query<{
      status: string
      description: string
      linked_spec_id: string | null
    }>(
      fixture.projectId,
      'SELECT status, description, linked_spec_id FROM tasks WHERE id = ?',
      'task_abc'
    )[0]
    expect(startedRow).toBeDefined()
    expect(startedRow.status).toBe('in_progress')
    expect(startedRow.description).toBe('Wire up the thing')
    expect(startedRow.linked_spec_id).toBe('spec_9')

    await stateStorage.completeTask(fixture.projectId)
    const completedRow = prjctDb.query<{
      status: string
      description: string
      linked_spec_id: string | null
    }>(
      fixture.projectId,
      'SELECT status, description, linked_spec_id FROM tasks WHERE id = ?',
      'task_abc'
    )[0]
    expect(completedRow.status).toBe('completed')
    const completed = prjctDb.query<{ completed_at: string | null }>(
      fixture.projectId,
      'SELECT completed_at FROM tasks WHERE id = ?',
      'task_abc'
    )[0]
    expect(completed.completed_at).toBeTruthy()
  })

  it('mirrors pause + resume — a paused task no longer reads stale in_progress', async () => {
    await stateStorage.startTask(fixture.projectId, {
      id: 'task_pause',
      description: 'Task that gets paused',
      sessionId: 'sess_2',
    })

    await stateStorage.pauseTask(fixture.projectId, 'context switch')
    const pausedRow = prjctDb.query<{
      status: string
      paused_at: string | null
      pause_reason: string | null
    }>(
      fixture.projectId,
      'SELECT status, paused_at, pause_reason FROM tasks WHERE id = ?',
      'task_pause'
    )[0]
    expect(pausedRow.status).toBe('paused')
    expect(pausedRow.paused_at).toBeTruthy()
    expect(pausedRow.pause_reason).toBe('context switch')

    await stateStorage.resumeTask(fixture.projectId, 'task_pause')
    const resumedRow = prjctDb.query<{
      status: string
      paused_at: string | null
      pause_reason: string | null
    }>(
      fixture.projectId,
      'SELECT status, paused_at, pause_reason FROM tasks WHERE id = ?',
      'task_pause'
    )[0]
    expect(resumedRow.status).toBe('in_progress')
    expect(resumedRow.paused_at).toBeNull()
    expect(resumedRow.pause_reason).toBeNull()
  })

  it('mirrors workspace (crew/multi-agent) start + complete — previously invisible to the typed table', async () => {
    await stateStorage.startTaskInWorkspace(
      fixture.projectId,
      {
        id: 'task_ws',
        description: 'Parallel worktree task',
        sessionId: 'sess_ws',
        workspaceId: 'ws-1',
        worktreePath: '/tmp/worktree-1',
      },
      'ws-1'
    )

    const startedWorkspaceRow = prjctDb.query<{ status: string; description: string }>(
      fixture.projectId,
      'SELECT status, description FROM tasks WHERE id = ?',
      'task_ws'
    )[0]
    expect(startedWorkspaceRow).toBeDefined()
    expect(startedWorkspaceRow.status).toBe('in_progress')
    expect(startedWorkspaceRow.description).toBe('Parallel worktree task')

    await stateStorage.completeTaskInWorkspace(fixture.projectId, 'ws-1')
    const completedWorkspaceRow = prjctDb.query<{ status: string; description: string }>(
      fixture.projectId,
      'SELECT status, description FROM tasks WHERE id = ?',
      'task_ws'
    )[0]
    expect(completedWorkspaceRow.status).toBe('completed')
  })
})
