/**
 * C8: workflow execution is persisted via the run-recorder — workflow_runs,
 * gate_evaluation, workflow_run_step. Tests the persistence layer directly
 * (deterministic); the engine wiring is covered by typecheck + the existing
 * workflow-engine suites.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'
import prjctDb from '../../storage/database'
import {
  finishWorkflowRun,
  getRecentWorkflowRuns,
  recordGateEvaluation,
  recordRunStep,
  startWorkflowRun,
} from '../../workflow-engine/run-recorder'

const fixture: {
  tmpRoot: string
  projectId: string
} = {
  tmpRoot: '',
  projectId: '',
}

const original = pathManager.getGlobalProjectPath.bind(pathManager)

beforeEach(async () => {
  fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-wfrun-'))
  fixture.projectId = `wfrun-${Math.random().toString(36).slice(2, 10)}`
  pathManager.getGlobalProjectPath = (id: string) => path.join(fixture.tmpRoot, id)
  prjctDb.getDb(fixture.projectId)
})
afterEach(async () => {
  prjctDb.close()
  pathManager.getGlobalProjectPath = original
  await fs.rm(fixture.tmpRoot, { recursive: true, force: true })
})

describe('workflow run recorder (C8)', () => {
  it('persists a run with a gate eval and a step, then finalizes status', () => {
    const runId = startWorkflowRun(fixture.projectId, 'before:ship', 'task-1')
    expect(runId).toBeTruthy()
    recordGateEvaluation(fixture.projectId, runId, 7, true)
    recordGateEvaluation(fixture.projectId, runId, 8, false, 'tests red')
    recordRunStep(fixture.projectId, runId, 9, 0, 'ok')
    finishWorkflowRun(fixture.projectId, runId, 'passed')

    const run = prjctDb.query<{ status: string; command: string; work_cycle_id: string }>(
      fixture.projectId,
      'SELECT status, command, work_cycle_id FROM workflow_runs WHERE id = ?',
      runId
    )[0]
    expect(run.status).toBe('passed')
    expect(run.command).toBe('before:ship')
    expect(run.work_cycle_id).toBe('task-1')

    const gates = prjctDb.query<{ passed: number; reason: string | null }>(
      fixture.projectId,
      'SELECT passed, reason FROM gate_evaluation WHERE run_id = ? ORDER BY passed DESC',
      runId
    )
    expect(gates.length).toBe(2)
    expect(gates[0].passed).toBe(1)
    expect(gates[1].passed).toBe(0)
    expect(gates[1].reason).toBe('tests red')

    const steps = prjctDb.query<{ status: string; seq: number }>(
      fixture.projectId,
      'SELECT status, seq FROM workflow_run_step WHERE run_id = ?',
      runId
    )
    expect(steps.length).toBe(1)
    expect(steps[0].status).toBe('ok')
  })

  it('recorder calls with a null runId are no-ops (never throw)', () => {
    expect(() => {
      recordGateEvaluation(fixture.projectId, null, 1, true)
      recordRunStep(fixture.projectId, null, 1, 0, 'ok')
      finishWorkflowRun(fixture.projectId, null, 'passed')
    }).not.toThrow()
    const runs = prjctDb.query<{ id: string }>(fixture.projectId, 'SELECT id FROM workflow_runs')
    expect(runs.length).toBe(0)
  })

  it('getRecentWorkflowRuns summarizes runs with step + gate counts', () => {
    const runId = startWorkflowRun(fixture.projectId, 'before:ship', 'task-x')
    recordGateEvaluation(fixture.projectId, runId, 1, true)
    recordGateEvaluation(fixture.projectId, runId, 2, false, 'red')
    recordRunStep(fixture.projectId, runId, 3, 0, 'ok')
    finishWorkflowRun(fixture.projectId, runId, 'blocked')

    const summary = getRecentWorkflowRuns(fixture.projectId, 10)
    expect(summary.length).toBe(1)
    expect(summary[0].command).toBe('before:ship')
    expect(summary[0].status).toBe('blocked')
    expect(summary[0].steps).toBe(1)
    expect(summary[0].gatesPassed).toBe(1)
    expect(summary[0].gatesFailed).toBe(1)
  })
})
