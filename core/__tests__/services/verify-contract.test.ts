/**
 * Proof-carrying verify contract (SEC-free, T4 lesson): a fix is a measurement.
 * Real temp git repo — the same command must flip failing→passing across a real
 * tree change, and every shortcut (no repro, still failing, passing-repro) is
 * refused. Asserts on the stored receipt and git-bound tree hash.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { latestContract, recordFix, recordRepro } from '../../services/verify-contract'
import prjctDb from '../../storage/database'
import { patchPathManager, restorePathManager } from '../_setup/path-manager-mock'

const run = promisify(execFile)
const fixture = { root: '', dir: '', projectId: '' }

async function git(args: string[]): Promise<void> {
  await run('git', args, { cwd: fixture.dir })
}

beforeEach(async () => {
  fixture.root = await fsp.mkdtemp(path.join(os.tmpdir(), 'prjct-verify-contract-'))
  fixture.dir = path.join(fixture.root, 'proj')
  await fsp.mkdir(path.join(fixture.dir, '.prjct'), { recursive: true })
  fixture.projectId = `vc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await fsp.writeFile(
    path.join(fixture.dir, '.prjct', 'prjct.config.json'),
    JSON.stringify({ projectId: fixture.projectId, dataPath: fixture.root })
  )
  patchPathManager(fixture.root)
  prjctDb.run(fixture.projectId, 'SELECT 1 WHERE 1=0')
  await git(['init', '-q'])
  await git(['config', 'user.email', 't@t'])
  await git(['config', 'user.name', 't'])
  await fsp.writeFile(path.join(fixture.dir, 'seed.txt'), 'seed\n')
  await git(['add', '.'])
  await git(['commit', '-q', '-m', 'seed'])
})

afterEach(async () => {
  restorePathManager()
  await fsp.rm(fixture.root, { recursive: true, force: true }).catch(() => {})
})

// Passes only once `fixed.txt` exists — a clean failing→passing switch.
const CMD = 'test -f fixed.txt'

describe('verify contract', () => {
  it('records a reproduction only when the command fails', async () => {
    const repro = await recordRepro(fixture.projectId, fixture.dir, CMD)
    expect(repro.ok).toBe(true)
    expect(repro.receipt?.phase).toBe('repro')
    expect(repro.receipt?.binding?.treeHash).toBeTruthy()
    expect(latestContract(fixture.projectId, CMD)?.phase).toBe('repro')
  })

  it('refuses to record a passing command as a reproduction', async () => {
    const res = await recordRepro(fixture.projectId, fixture.dir, 'exit 0')
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/already passes/i)
  })

  it('refuses a command that never really ran (not found / timeout) as a reproduction', async () => {
    const missing = await recordRepro(
      fixture.projectId,
      fixture.dir,
      'definitely-not-a-command-xyz'
    )
    expect(missing.ok).toBe(false)
    expect(missing.reason).toMatch(/did not run to a real failure/i)
    const timedOut = await recordRepro(fixture.projectId, fixture.dir, 'sleep 5', {
      timeoutMs: 150,
    })
    expect(timedOut.ok).toBe(false)
    expect(timedOut.reason).toMatch(/did not run to a real failure/i)
  })

  it('refuses the contract outside a git checkout — the proof needs a tree', async () => {
    const plain = await fsp.mkdtemp(path.join(os.tmpdir(), 'prjct-verify-nogit-'))
    try {
      const res = await recordRepro(fixture.projectId, plain, 'exit 1')
      expect(res.ok).toBe(false)
      expect(res.reason).toMatch(/cannot bind/i)
    } finally {
      await fsp.rm(plain, { recursive: true, force: true })
    }
  })

  it('refuses a fix with no prior reproduction', async () => {
    const res = await recordFix(fixture.projectId, fixture.dir, CMD)
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/No reproduction/i)
  })

  it('refuses a fix while the command still fails', async () => {
    await recordRepro(fixture.projectId, fixture.dir, CMD)
    const res = await recordFix(fixture.projectId, fixture.dir, CMD)
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/still fails/i)
  })

  it('accepts a fix that flips failing→passing across a real tree change', async () => {
    const repro = await recordRepro(fixture.projectId, fixture.dir, CMD)
    expect(repro.ok).toBe(true)
    // The edit that fixes it — changes the tree (untracked file counts).
    await fsp.writeFile(path.join(fixture.dir, 'fixed.txt'), 'fixed\n')
    const fix = await recordFix(fixture.projectId, fixture.dir, CMD)
    expect(fix.ok).toBe(true)
    expect(fix.green?.phase).toBe('green')
    expect(fix.green?.binding?.treeHash).not.toBe(repro.receipt?.binding?.treeHash)
    expect(latestContract(fixture.projectId, CMD)?.phase).toBe('green')
  })
})
