/**
 * `prjct review-risk` — advisory size/delivery-geometry signal
 * (#18/19/20, minimal cut). Pure tier/geometry logic + an integration
 * smoke over a real tmp git repo + the graceful no-base path.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _internal, ReviewRiskCommands } from '../../commands/review-risk'
import { execFileAsync } from '../../utils/exec'

describe('review-risk — tier + geometry (pure)', () => {
  it('trivial → direct', () => {
    const t = _internal.tierOf({ files: 1, loc: 5 })
    expect(t).toBe('trivial')
    expect(_internal.geometryOf(t)).toBe('direct')
  })
  it('normal → single', () => {
    const t = _internal.tierOf({ files: 6, loc: 200 })
    expect(t).toBe('normal')
    expect(_internal.geometryOf(t)).toBe('single')
  })
  it('large (by files or LOC) → split', () => {
    expect(_internal.tierOf({ files: 40, loc: 50 })).toBe('large')
    expect(_internal.tierOf({ files: 3, loc: 900 })).toBe('large')
    expect(_internal.geometryOf('large')).toBe('split')
  })
})

describe('review-risk — integration (git)', () => {
  const fixture: {
    dir: string
  } = {
    dir: '',
  }
  const cmd = new ReviewRiskCommands()

  beforeEach(async () => {
    fixture.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-reviewrisk-'))
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: fixture.dir })
    await execFileAsync('git', ['config', 'user.email', 't@example.com'], { cwd: fixture.dir })
    await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: fixture.dir })
    await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: fixture.dir })
    await fs.mkdir(path.join(fixture.dir, '.prjct'), { recursive: true })
    await fs.writeFile(
      path.join(fixture.dir, '.prjct/prjct.config.json'),
      JSON.stringify({ projectId: `rr-${Date.now()}` })
    )
  })

  afterEach(async () => {
    await fs.rm(fixture.dir, { recursive: true, force: true }).catch(() => {})
  })

  it('graceful no-signal when nothing is ahead of the base', async () => {
    await fs.writeFile(path.join(fixture.dir, 'a.txt'), 'x')
    await execFileAsync('git', ['add', '.'], { cwd: fixture.dir })
    await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: fixture.dir })
    const r = await cmd.reviewRisk(null, fixture.dir, { md: true })
    expect(r.success).toBe(true)
    expect(r.files).toBe(0)
    expect(r.tier).toBe('trivial')
    // Regression: the no-signal early-return must still carry `geometry`
    // (was omitted → undefined for structured-result consumers).
    expect(r.geometry).toBe('direct')
    // 15s: this spawns several git processes; under CI runner load the
    // default 5s timeout flakes (it failed a RELEASE run on 2026-06-11).
  }, 15_000)

  it('flags a large changeset on a feature branch and suggests split', async () => {
    await fs.writeFile(path.join(fixture.dir, 'seed.txt'), 'x')
    await execFileAsync('git', ['add', '.'], { cwd: fixture.dir })
    await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: fixture.dir })
    await execFileAsync('git', ['checkout', '-q', '-b', 'feat/big'], { cwd: fixture.dir })
    for (const i of Array.from({ length: 12 }, (_, index) => index)) {
      await fs.writeFile(
        path.join(fixture.dir, `f${i}.ts`),
        `export const v${i} = ${i}\n`.repeat(40)
      )
    }
    await execFileAsync('git', ['add', '.'], { cwd: fixture.dir })
    await execFileAsync('git', ['commit', '-q', '-m', 'big'], { cwd: fixture.dir })
    const r = await cmd.reviewRisk(null, fixture.dir, { md: true })
    expect(r.success).toBe(true)
    expect(r.tier).toBe('large')
    expect(r.geometry).toBe('split')
  }, 15_000)
})
