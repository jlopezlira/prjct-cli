/**
 * runVerifyCommand: pass/fail exit mapping, tail capture, and timeout — the
 * shared runner behind `prjct verify` and the proof-carrying contract.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runVerifyCommand } from '../../services/verify-runner'

const fixture = { dir: '' }

beforeEach(async () => {
  fixture.dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'prjct-verify-runner-'))
})

afterEach(async () => {
  await fsp.rm(fixture.dir, { recursive: true, force: true }).catch(() => {})
})

describe('runVerifyCommand', () => {
  it('reports a passing command as ok with exit 0', async () => {
    const run = await runVerifyCommand(fixture.dir, 'exit 0')
    expect(run.ok).toBe(true)
    expect(run.exitCode).toBe(0)
  })

  it('reports a failing command with its exit code and a tail', async () => {
    const run = await runVerifyCommand(fixture.dir, 'echo boom >&2; exit 3')
    expect(run.ok).toBe(false)
    expect(run.exitCode).toBe(3)
    expect(run.detail).toContain('boom')
  })

  it('kills and reports a command that exceeds the timeout', async () => {
    const run = await runVerifyCommand(fixture.dir, 'sleep 5', { timeoutMs: 200 })
    expect(run.ok).toBe(false)
    expect(run.exitCode).toBeNull()
    expect(run.detail).toMatch(/timed out/i)
  })
})
