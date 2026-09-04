/**
 * `prjct harness` — the two Body-creation paths wired through the command.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { HarnessCommands } from '../../commands/harness'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import { prjctDb } from '../../storage/database'
import { instructionFailureStorage } from '../../storage/instruction-failure-storage'

describe('prjct harness command', () => {
  const cmd = new HarnessCommands()
  const fixture: {
    logSpy: ReturnType<typeof spyOn>
    errSpy: ReturnType<typeof spyOn>
  } = {
    logSpy: undefined as unknown as ReturnType<typeof spyOn>,
    errSpy: undefined as unknown as ReturnType<typeof spyOn>,
  }

  beforeEach(() => {
    fixture.logSpy = spyOn(console, 'log').mockImplementation(() => {})
    fixture.errSpy = spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    fixture.logSpy.mockRestore()
    fixture.errSpy.mockRestore()
  })

  const logged = (): string => fixture.logSpy.mock.calls.flat().join('\n')

  it('list prints the stealable rigs', async () => {
    const r = await cmd.list()
    expect(r.success).toBe(true)
    expect(logged()).toContain('safe-agentic-workflow')
  })

  it('use <known> emits the adoption plan', async () => {
    const r = await cmd.use('safe-agentic-workflow')
    expect(r.success).toBe(true)
    expect(logged()).toContain('adopt rig')
  })

  it('use <unknown> fails loudly', async () => {
    const r = await cmd.use('does-not-exist')
    expect(r.success).toBe(false)
  })

  it('learn-from emits the induction dispatch even with no project', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-harness-'))
    const r = await cmd.learnFrom(dir)
    expect(r.success).toBe(true)
    expect(logged()).toContain('induction')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('score keeps missing model outcome evidence incomplete', async () => {
    const r = await cmd.score(process.cwd(), { md: true })
    expect(r.success).toBe(true)
    expect(r.programDone).toBe(false)
    expect(logged()).toContain('Harness score')
  })

  it('instructions rejects invalid windows with stable result fields', async () => {
    const r = await cmd.instructions('90d', process.cwd(), { md: true })
    expect(r.success).toBe(false)
    expect(r.error).toContain('Invalid instruction window')
  })

  it('instructions returns the stable report fields', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-harness-instructions-'))
    const projectId = `harness-instructions-${Math.random().toString(36).slice(2, 10)}`
    const originalGetGlobalProjectPath = pathManager.getGlobalProjectPath.bind(pathManager)
    const projectSpy = spyOn(configManager, 'getProjectId').mockResolvedValue(projectId)
    pathManager.getGlobalProjectPath = (id: string) => path.join(dir, id)
    try {
      const r = await cmd.instructions(null, dir, { md: true })
      expect(r).toMatchObject({
        success: true,
        window: '7d',
        total: 0,
        attributed: 0,
        attributionRate: 0,
        open: 0,
        resolved: 0,
        falsePositive: 0,
        falseTriggerRate: 0,
        groups: [],
        unresolved: [],
      })
      expect(logged()).toContain('No observed sessions')
    } finally {
      prjctDb.close(projectId)
      projectSpy.mockRestore()
      pathManager.getGlobalProjectPath = originalGetGlobalProjectPath
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('instructions set records a false-positive disposition', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-harness-disposition-'))
    const projectId = `harness-disposition-${Math.random().toString(36).slice(2, 10)}`
    const originalGetGlobalProjectPath = pathManager.getGlobalProjectPath.bind(pathManager)
    const projectSpy = spyOn(configManager, 'getProjectId').mockResolvedValue(projectId)
    pathManager.getGlobalProjectPath = (targetId: string) => path.join(dir, targetId)
    try {
      const recorded = instructionFailureStorage.record(projectId, {
        source: 'test',
        runtime: 'codex',
        model: 'codex-eval',
        category: 'scope-creep',
        expectedBehavior: 'stay in scope',
        observedBehavior: 'expanded scope',
      })
      const result = await cmd.instructionDisposition(recorded.failure.id, 'false-positive', dir)
      expect(result).toMatchObject({
        success: true,
        id: recorded.failure.id,
        disposition: 'false_positive',
      })
      expect(instructionFailureStorage.getById(projectId, recorded.failure.id)?.disposition).toBe(
        'false_positive'
      )
    } finally {
      prjctDb.close(projectId)
      projectSpy.mockRestore()
      pathManager.getGlobalProjectPath = originalGetGlobalProjectPath
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('instructions set fails for missing cases and invalid dispositions', async () => {
    expect((await cmd.instructionDisposition(null, null)).success).toBe(false)
    expect((await cmd.instructionDisposition('if_missing', 'ignored')).success).toBe(false)
  })
})
