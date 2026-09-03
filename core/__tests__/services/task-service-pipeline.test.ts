import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { indexProject } from '../../domain/bm25'
import pathManager from '../../infrastructure/path-manager'
import { applyQaReport, getQaPlan, upsertQaPlan } from '../../services/qa-plan'
import { runQa } from '../../services/qa-runner'
import { setTaskStatus, startTask } from '../../services/task-service'
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

describe('task service — QA phase', () => {
  beforeEach(async () => {
    fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-task-service-qa-'))
    fixture.projectId = `qa-service-${Date.now()}`
    fixture.projectPath = path.join(fixture.tmpRoot, 'repo')
    patchPathManager(fixture.tmpRoot)
    await fs.mkdir(pathManager.getStoragePath(fixture.projectId, ''), { recursive: true })
    await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
    await fs.writeFile(
      path.join(fixture.projectPath, '.prjct', 'prjct.config.json'),
      JSON.stringify({
        projectId: fixture.projectId,
        dataPath: fixture.tmpRoot,
        qa: { mode: 'strict' },
      })
    )
  })

  afterEach(async () => {
    prjctDb.close()
    restorePathManager()
    await fs.rm(fixture.tmpRoot, { recursive: true, force: true }).catch(() => {})
  })

  it('work start carries the QA directive; strict done blocks until the plan is verified', async () => {
    const outcome = await startTask(
      fixture.projectId,
      fixture.projectPath,
      'add billing retry handling with failure recovery',
      { skipHooks: true }
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.qa?.mode).toBe('strict')
    expect(outcome.qa?.planExists).toBe(false)
    expect(outcome.qa?.directive).toContain('BEFORE implementing')
    expect(outcome.qa?.section).toContain('prjct qa plan --json')

    const blocked = await setTaskStatus(fixture.projectId, fixture.projectPath, 'done')
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) {
      expect(blocked.reason).toBe('gate-blocked')
      expect(blocked.reason === 'gate-blocked' && blocked.message).toContain('prjct qa next')
    }

    // A plan whose flows are all machine-verified for this HEAD clears the gate.
    const taskId = outcome.taskId ?? ''
    upsertQaPlan(
      fixture.projectId,
      taskId,
      {
        criteria: ['retry endpoint returns 200 — cli probe'],
        flows: [{ name: 'retry ok', kind: 'cli', probe: { type: 'cli', command: 'true' } }],
      },
      { mode: 'strict' }
    )
    const plan = getQaPlan(fixture.projectId, taskId)
    await runQa(fixture.projectPath, fixture.projectId, { plan })
    const acId = plan?.criteria[0]?.id ?? ''
    applyQaReport(fixture.projectId, taskId, [
      {
        id: acId,
        verdict: 'met',
        evidence:
          'curl http://localhost/retry answered 200 with {"ok":true} on three consecutive calls',
      },
    ])
    const done = await setTaskStatus(fixture.projectId, fixture.projectPath, 'done')
    expect(done.ok).toBe(true)
  })

  it('does not apply to H0 cycles', async () => {
    const outcome = await startTask(fixture.projectId, fixture.projectPath, 'fix typo in README', {
      skipHooks: true,
    })
    expect(outcome.ok).toBe(true)
    if (outcome.harness?.level === 'H0') expect(outcome.qa).toBeUndefined()
  })
})
