import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { indexProject } from '../../domain/bm25'
import pathManager from '../../infrastructure/path-manager'
import { startTask } from '../../services/task-service'
import { MAIN_WORKSPACE_ID } from '../../services/workspace-id'
import { prjctDb } from '../../storage/database'
import { getTaskPipelineState } from '../../storage/task-pipeline-storage'
import { patchPathManager, restorePathManager } from '../_setup/path-manager-mock'

const fixture: {
  tmpRoot: string
  projectId: string
  projectPath: string
} = {
  tmpRoot: '',
  projectId: '',
  projectPath: '',
}

describe('task service pipeline orchestration', () => {
  beforeEach(async () => {
    fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-task-service-pipeline-'))
    fixture.projectId = `pipeline-service-${Date.now()}`
    fixture.projectPath = path.join(fixture.tmpRoot, 'repo')
    patchPathManager(fixture.tmpRoot)
    await fs.mkdir(pathManager.getStoragePath(fixture.projectId, ''), { recursive: true })
    await fs.mkdir(fixture.projectPath, { recursive: true })
  })

  afterEach(async () => {
    prjctDb.close()
    restorePathManager()
    await fs.rm(fixture.tmpRoot, { recursive: true, force: true }).catch(() => {})
  })

  it('starts trivial work in the direct station', async () => {
    const outcome = await startTask(fixture.projectId, fixture.projectPath, 'fix typo in README', {
      skipHooks: true,
    })

    expect(outcome.ok).toBe(true)
    expect(outcome.pipeline?.classification).toBe('trivial')
    expect(outcome.pipeline?.station).toBe('direct')
    expect(outcome.pipeline?.nextAction).toContain('Proceed directly')
    expect(outcome.taskId).toBeTruthy()
    expect(
      getTaskPipelineState(fixture.projectId, outcome.taskId ?? '', MAIN_WORKSPACE_ID)?.station
    ).toBe('direct')
  })

  it('starts substantive work in the spec-required test-first station', async () => {
    const outcome = await startTask(
      fixture.projectId,
      fixture.projectPath,
      'add billing retry handling with failure recovery',
      { skipHooks: true }
    )

    expect(outcome.ok).toBe(true)
    expect(outcome.pipeline?.classification).toBe('substantive')
    expect(outcome.pipeline?.station).toBe('spec_required')
    expect(outcome.pipeline?.nextAction).toContain('Create or link a reviewed spec')
    expect(outcome.pipeline?.nextAction).toContain('tests before implementation')
    expect(
      getTaskPipelineState(fixture.projectId, outcome.taskId ?? '', MAIN_WORKSPACE_ID)
        ?.requiresTestsFirst
    ).toBe(true)
  })

  it('surfaces likely files from the project index when work starts', async () => {
    await fs.mkdir(path.join(fixture.projectPath, 'core', 'server'), { recursive: true })
    await fs.writeFile(
      path.join(fixture.projectPath, 'core', 'server', 'headless-api.ts'),
      'export function mapHeadlessApiEndpoints() { return [] }'
    )
    await fs.writeFile(
      path.join(fixture.projectPath, 'core', 'server', 'billing.ts'),
      'export function updateBilling() { return null }'
    )
    await indexProject(fixture.projectPath, fixture.projectId)

    const outcome = await startTask(
      fixture.projectId,
      fixture.projectPath,
      'map headless API endpoints',
      {
        skipHooks: true,
      }
    )

    expect(outcome.ok).toBe(true)
    expect(outcome.likelyFiles?.[0]?.path).toBe('core/server/headless-api.ts')
    expect(outcome.likelyFiles?.[0]?.signals).toContain('bm25')
  })
})
