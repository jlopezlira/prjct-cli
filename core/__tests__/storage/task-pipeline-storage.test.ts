import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'
import { MAIN_WORKSPACE_ID } from '../../services/workspace-id'
import { prjctDb } from '../../storage/database'
import { getTaskPipelineState, upsertTaskPipelineState } from '../../storage/task-pipeline-storage'

let tmpRoot: string
let projectId: string

const originalGetGlobalProjectPath = pathManager.getGlobalProjectPath.bind(pathManager)

describe('task pipeline storage', () => {
  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-task-pipeline-'))
    projectId = `pipeline-${Date.now()}`
    pathManager.getGlobalProjectPath = (id: string) => path.join(tmpRoot, id)
    await fs.mkdir(path.join(tmpRoot, projectId), { recursive: true })
    prjctDb.getDb(projectId)
  })

  afterEach(async () => {
    prjctDb.close()
    pathManager.getGlobalProjectPath = originalGetGlobalProjectPath
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  })

  it('persists and updates a pipeline state by project/task/workspace', () => {
    upsertTaskPipelineState(projectId, {
      taskId: 'task-1',
      workspaceId: MAIN_WORKSPACE_ID,
      classification: 'substantive',
      station: 'spec_required',
      requiresSpec: true,
      requiresTestsFirst: true,
      reason: 'substantive-keyword',
      linkedSpecId: null,
    })

    let row = getTaskPipelineState(projectId, 'task-1', MAIN_WORKSPACE_ID)
    expect(row?.station).toBe('spec_required')
    expect(row?.requiresTestsFirst).toBe(true)

    upsertTaskPipelineState(projectId, {
      taskId: 'task-1',
      workspaceId: MAIN_WORKSPACE_ID,
      classification: 'substantive',
      station: 'test_red',
      requiresSpec: true,
      requiresTestsFirst: true,
      reason: 'linked-reviewed-spec',
      linkedSpecId: 'spec-1',
    })

    row = getTaskPipelineState(projectId, 'task-1', MAIN_WORKSPACE_ID)
    expect(row?.station).toBe('test_red')
    expect(row?.linkedSpecId).toBe('spec-1')
  })

  it('updates and returns state with one SQLite statement while preserving createdAt', () => {
    const initial = upsertTaskPipelineState(projectId, {
      taskId: 'task-efficient-upsert',
      workspaceId: MAIN_WORKSPACE_ID,
      classification: 'substantive',
      station: 'spec_required',
      requiresSpec: true,
      requiresTestsFirst: true,
      reason: 'initial',
      linkedSpecId: null,
    })

    const querySpy = spyOn(prjctDb, 'query')
    const runSpy = spyOn(prjctDb, 'run')
    const updated = upsertTaskPipelineState(projectId, {
      taskId: 'task-efficient-upsert',
      workspaceId: MAIN_WORKSPACE_ID,
      classification: 'substantive',
      station: 'test_red',
      requiresSpec: true,
      requiresTestsFirst: true,
      reason: 'linked-reviewed-spec',
      linkedSpecId: 'spec-efficient-upsert',
    })

    expect(updated.createdAt).toBe(initial.createdAt)
    expect(updated.station).toBe('test_red')
    expect(updated.linkedSpecId).toBe('spec-efficient-upsert')
    expect(runSpy).not.toHaveBeenCalled()
    expect(querySpy).toHaveBeenCalledTimes(1)

    querySpy.mockRestore()
    runSpy.mockRestore()
  })

  it('keeps main and child workspace rows independent', () => {
    upsertTaskPipelineState(projectId, {
      taskId: 'task-1',
      workspaceId: MAIN_WORKSPACE_ID,
      classification: 'trivial',
      station: 'direct',
      requiresSpec: false,
      requiresTestsFirst: false,
      reason: 'trivial-keyword',
      linkedSpecId: null,
    })
    upsertTaskPipelineState(projectId, {
      taskId: 'task-1',
      workspaceId: 'child-workspace',
      classification: 'substantive',
      station: 'spec_required',
      requiresSpec: true,
      requiresTestsFirst: true,
      reason: 'substantive-keyword',
      linkedSpecId: null,
    })

    expect(getTaskPipelineState(projectId, 'task-1', MAIN_WORKSPACE_ID)?.station).toBe('direct')
    expect(getTaskPipelineState(projectId, 'task-1', 'child-workspace')?.station).toBe(
      'spec_required'
    )
  })
})
