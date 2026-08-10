import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'
import { estimateTaskForStart } from '../../services/task-estimation'

const fixture: {
  tmpRoot: string | null
} = {
  tmpRoot: null,
}
const originalGetGlobalProjectPath = pathManager.getGlobalProjectPath.bind(pathManager)

describe('estimateTaskForStart', () => {
  beforeEach(async () => {
    fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-estimate-'))
    pathManager.getGlobalProjectPath = (projectId: string) => path.join(fixture.tmpRoot!, projectId)
  })

  afterEach(async () => {
    pathManager.getGlobalProjectPath = originalGetGlobalProjectPath
    if (fixture.tmpRoot) {
      await fs.rm(fixture.tmpRoot, { recursive: true, force: true })
      fixture.tmpRoot = null
    }
  })

  it('uses heuristic estimate when no historical outcomes exist', async () => {
    const estimate = await estimateTaskForStart('project-a', 'fix typo in setup output')

    expect(estimate.source).toBe('heuristic')
    expect(estimate.taskType).toBe('feature')
    expect(estimate.estimatedPoints).toBe(5)
    expect(estimate.estimatedMinutes).toBe(90)
  })

  // The history-based estimate path was backed by the outcome-* subsystem,
  // which had zero writers and was removed. `suggestFromHistory` now
  // always returns null, so estimates always fall back to heuristics.
  // When a real outcome feed lands (e.g. via a Stop hook that records
  // durations), reinstate this test alongside the data source.
})
