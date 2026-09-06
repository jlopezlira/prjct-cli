/**
 * `prjct verify` command: one-shot pass/fail, and the repro→fix contract
 * surfaced through the CLI against a real temp git project.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { VerifyCommands } from '../../commands/verify'
import prjctDb from '../../storage/database'
import { patchPathManager, restorePathManager } from '../_setup/path-manager-mock'

const run = promisify(execFile)
const fixture = { root: '', dir: '', projectId: '' }
const cmds = new VerifyCommands()

beforeEach(async () => {
  fixture.root = await fsp.mkdtemp(path.join(os.tmpdir(), 'prjct-verify-cmd-'))
  fixture.dir = path.join(fixture.root, 'proj')
  await fsp.mkdir(path.join(fixture.dir, '.prjct'), { recursive: true })
  fixture.projectId = `vcmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await fsp.writeFile(
    path.join(fixture.dir, '.prjct', 'prjct.config.json'),
    JSON.stringify({ projectId: fixture.projectId, dataPath: fixture.root })
  )
  patchPathManager(fixture.root)
  prjctDb.run(fixture.projectId, 'SELECT 1 WHERE 1=0')
  await run('git', ['init', '-q'], { cwd: fixture.dir })
  await run('git', ['config', 'user.email', 't@t'], { cwd: fixture.dir })
  await run('git', ['config', 'user.name', 't'], { cwd: fixture.dir })
  await fsp.writeFile(path.join(fixture.dir, 'seed.txt'), 'seed\n')
  await run('git', ['add', '.'], { cwd: fixture.dir })
  await run('git', ['commit', '-q', '-m', 'seed'], { cwd: fixture.dir })
})

afterEach(async () => {
  restorePathManager()
  await fsp.rm(fixture.root, { recursive: true, force: true }).catch(() => {})
})

describe('prjct verify', () => {
  it('one-shot: passes and fails by exit code', async () => {
    expect((await cmds.verify('exit 0', fixture.dir)).success).toBe(true)
    const failed = await cmds.verify('exit 1', fixture.dir)
    expect(failed.success).toBe(false)
  })

  it('drives the repro→fix contract end to end', async () => {
    const repro = await cmds.verify('repro test -f fixed.txt', fixture.dir)
    expect(repro.success).toBe(true)

    const early = await cmds.verify('fix test -f fixed.txt', fixture.dir)
    expect(early.success).toBe(false) // still failing

    await fsp.writeFile(path.join(fixture.dir, 'fixed.txt'), 'ok\n')
    const fixed = await cmds.verify('fix test -f fixed.txt', fixture.dir)
    expect(fixed.success).toBe(true)
    expect(fixed.message).toMatch(/red→green/i)
  })
})
