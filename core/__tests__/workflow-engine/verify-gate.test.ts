/**
 * Deterministic Stop-Slop gate (harness pillar 2 — agent loop).
 *
 * `verify:<command>` runs a blocking check; a non-zero exit throws a
 * standardized stop-the-line error. As a `gate` rule this lands in
 * `gatesFailed` and aborts the lifecycle verb (e.g. `ship`), so a degraded
 * model's unverified output is caught by structure, not by the user.
 */

import { describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { WorkflowRule } from '../../types/storage/extended'
import { _verify, detectVerifyCommand } from '../../workflow-engine/workflow-engine'

const { runVerifyAction, VERIFY_ACTION_PREFIX } = _verify

function rule(action: string, overrides: Partial<WorkflowRule> = {}): WorkflowRule {
  return {
    id: 1,
    type: 'gate',
    command: 'ship',
    position: 'before',
    action,
    description: null,
    enabled: true,
    timeoutMs: 10_000,
    createdAt: '2026-06-28T00:00:00Z',
    sortOrder: 0,
    whenExpr: null,
    parallel: false,
    trustSource: 'local',
    ...overrides,
  }
}

describe('verify: deterministic Stop-Slop gate', () => {
  it('passes when the check command exits zero', async () => {
    await expect(
      runVerifyAction(rule(`${VERIFY_ACTION_PREFIX}true`), process.cwd())
    ).resolves.toBeUndefined()
  })

  it('throws actionable stop-the-line guidance when the check fails', async () => {
    const promise = runVerifyAction(rule(`${VERIFY_ACTION_PREFIX}false`), process.cwd())
    await expect(promise).rejects.toThrow('Verification failed')
    await expect(promise).rejects.toThrow('Stop-the-line')
  })

  it('rejects an empty command', async () => {
    await expect(runVerifyAction(rule(VERIFY_ACTION_PREFIX), process.cwd())).rejects.toThrow(
      'Empty command'
    )
  })

  it('refuses imported (untrusted) verify rules until approved', async () => {
    await expect(
      runVerifyAction(
        rule(`${VERIFY_ACTION_PREFIX}true`, { trustSource: 'imported' }),
        process.cwd()
      )
    ).rejects.toThrow('Refusing to run imported')
  })
})

describe('verify:auto — detects the project verification command', () => {
  const fixture: {
    dir: string
  } = {
    dir: '',
  }

  async function makeDir(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), 'prjct-verify-auto-'))
  }

  it('resolves to the package-manager test command when scripts.test exists', async () => {
    fixture.dir = await makeDir()
    await fs.writeFile(
      path.join(fixture.dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'x' } })
    )
    await fs.writeFile(path.join(fixture.dir, 'bun.lockb'), '')
    expect(await detectVerifyCommand(fixture.dir)).toBe('bun test')
    await fs.rm(fixture.dir, { recursive: true, force: true })
  })

  it('defaults to npm when no lockfile pins the manager', async () => {
    fixture.dir = await makeDir()
    await fs.writeFile(
      path.join(fixture.dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'x' } })
    )
    expect(await detectVerifyCommand(fixture.dir)).toBe('npm test')
    await fs.rm(fixture.dir, { recursive: true, force: true })
  })

  it('returns null (no convention) when there is no test script', async () => {
    fixture.dir = await makeDir()
    await fs.writeFile(path.join(fixture.dir, 'package.json'), JSON.stringify({ name: 'x' }))
    expect(await detectVerifyCommand(fixture.dir)).toBeNull()
    await fs.rm(fixture.dir, { recursive: true, force: true })
  })

  it('verify:auto throws actionable guidance when nothing is detected', async () => {
    fixture.dir = await makeDir()
    await expect(runVerifyAction(rule(`${VERIFY_ACTION_PREFIX}auto`), fixture.dir)).rejects.toThrow(
      'verify:auto found no test script'
    )
    await fs.rm(fixture.dir, { recursive: true, force: true })
  })
})
