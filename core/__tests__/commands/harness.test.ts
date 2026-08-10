/**
 * `prjct harness` — the two Body-creation paths wired through the command.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { HarnessCommands } from '../../commands/harness'

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

  it('score reports a done grade', async () => {
    const r = await cmd.score(process.cwd(), { md: true })
    expect(r.success).toBe(true)
    expect(r.programDone).toBe(true)
    expect(logged()).toContain('Harness score')
  })
})
