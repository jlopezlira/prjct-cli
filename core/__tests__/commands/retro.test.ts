/**
 * RetroCommands — `prjct retro [window]` smoke + window parsing tests.
 *
 * The full git-log path is exercised against a freshly-init'd repo in
 * tmpdir. Window parsing is tested independently via the exported
 * RetroCommands class instance.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { RetroCommands } from '../../commands/retro'
import { execFileAsync } from '../../utils/exec'

const fixture: {
  dir: string
} = {
  dir: '',
}
const cmd = new RetroCommands()

beforeEach(async () => {
  fixture.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-retro-test-'))
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: fixture.dir })
  await execFileAsync('git', ['config', 'user.email', 'a@example.com'], { cwd: fixture.dir })
  await execFileAsync('git', ['config', 'user.name', 'Alice'], { cwd: fixture.dir })
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: fixture.dir })

  // Minimal .prjct so ensureProjectInit() passes.
  await fs.mkdir(path.join(fixture.dir, '.prjct'), { recursive: true })
  await fs.writeFile(
    path.join(fixture.dir, '.prjct/prjct.config.json'),
    JSON.stringify({ projectId: `retro-test-${Date.now()}` })
  )
})

afterEach(async () => {
  await fs.rm(fixture.dir, { recursive: true, force: true }).catch(() => {})
})

async function commitAs(name: string, email: string, subject: string): Promise<void> {
  await execFileAsync('git', ['config', 'user.name', name], { cwd: fixture.dir })
  await execFileAsync('git', ['config', 'user.email', email], { cwd: fixture.dir })
  // Touch a unique file each time so commits aren't empty.
  const f = path.join(fixture.dir, `f-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`)
  await fs.writeFile(f, 'x')
  await execFileAsync('git', ['add', '.'], { cwd: fixture.dir })
  await execFileAsync('git', ['commit', '-q', '-m', subject], { cwd: fixture.dir })
}

describe('prjct retro — happy path', () => {
  it('reports zero commits in an empty window', async () => {
    const r = await cmd.retro('7d', fixture.dir, { md: true })
    expect(r.success).toBe(true)
    expect(r.commits).toBe(0)
    expect(r.contributors).toBe(0)
  })

  // Git-heavy: multiple commit() spawns + a retro git-log scan. Under
  // full-suite parallel load the default 5s bun timeout is too tight
  // (passes isolated, times out only when the box is saturated). Give
  // git-spawning tests explicit headroom — the assertion is the point,
  // not the wall-clock.
  it('groups commits per contributor and counts them', async () => {
    await commitAs('Alice', 'a@example.com', 'feat: alice 1')
    await commitAs('Bob', 'b@example.com', 'fix: bob 1')
    await commitAs('Alice', 'a@example.com', 'docs: alice 2')
    const r = await cmd.retro('7d', fixture.dir, { md: true })
    expect(r.success).toBe(true)
    expect(r.commits).toBe(3)
    expect(r.contributors).toBe(2)
  }, 20_000)

  it('rejects invalid window arguments', async () => {
    const r = await cmd.retro('not-a-window', fixture.dir, { md: true })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/Invalid window/)
  })

  it('rejects oversized day windows', async () => {
    const r = await cmd.retro('999d', fixture.dir, { md: true })
    expect(r.success).toBe(false)
  })

  it('refuses to run outside a git repo', async () => {
    const noGitDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-retro-nogit-'))
    await fs.mkdir(path.join(noGitDir, '.prjct'), { recursive: true })
    await fs.writeFile(
      path.join(noGitDir, '.prjct/prjct.config.json'),
      JSON.stringify({ projectId: `noprjct-${Date.now()}` })
    )
    const r = await cmd.retro('7d', noGitDir, { md: true })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/git/i)
    await fs.rm(noGitDir, { recursive: true, force: true })
  })

  it('accepts hour-window inputs', async () => {
    await commitAs('Alice', 'a@example.com', 'feat: 1h ago')
    const r = await cmd.retro('24h', fixture.dir, { md: true })
    expect(r.success).toBe(true)
    expect(r.window).toBe('24h')
  }, 20_000)
})
