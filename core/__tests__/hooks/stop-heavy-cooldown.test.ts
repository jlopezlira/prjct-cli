/**
 * Stop hook heavy-step cooldown — stamp-file contract.
 *
 * The 10min cooldown for the session-cadence Stop steps (pattern detection,
 * cleanup, embeddings backfill, land synthesis) is backed by a per-project
 * stamp file in the daemon run dir, so the COLD path (fresh detached worker
 * per Stop event, core/hooks/cold-entry.ts) honors it too — an in-memory map
 * resets on every cold spawn. Each test uses a fresh projectId, which makes
 * the in-memory fast path a guaranteed miss and exercises the file path
 * exactly as a cold worker would.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { heavyStepStampPath, heavyStepsDue } from '../../hooks/stop'

const fixture: { cliHome: string; prevHome?: string } = { cliHome: '' }

function freshProjectId(): string {
  return `test-cooldown-${Math.random().toString(36).slice(2, 10)}`
}

beforeEach(async () => {
  fixture.cliHome = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-stop-cooldown-test-'))
  fixture.prevHome = process.env.PRJCT_CLI_HOME
  process.env.PRJCT_CLI_HOME = fixture.cliHome
})

afterEach(async () => {
  if (fixture.prevHome === undefined) delete process.env.PRJCT_CLI_HOME
  else process.env.PRJCT_CLI_HOME = fixture.prevHome
  if (fixture.cliHome) {
    await fs.rm(fixture.cliHome, { recursive: true, force: true })
    fixture.cliHome = ''
  }
})

describe('Stop heavy-step cooldown — stamp file', () => {
  test('first Stop is due and claims the slot by writing the stamp', async () => {
    const projectId = freshProjectId()
    expect(await heavyStepsDue(projectId)).toBe(true)
    const stamp = heavyStepStampPath(projectId)
    expect(stamp.startsWith(path.join(fixture.cliHome, 'run'))).toBe(true)
    expect(await fs.stat(stamp)).toBeTruthy()
  })

  test('second Stop within 10min is not due (same-process fast path)', async () => {
    const projectId = freshProjectId()
    expect(await heavyStepsDue(projectId)).toBe(true)
    expect(await heavyStepsDue(projectId)).toBe(false)
  })

  test('cold path: a fresh process honors a recent stamp it never wrote', async () => {
    const projectId = freshProjectId()
    // Simulate a previous (now-exited) worker's claim: stamp exists, this
    // process has never seen the projectId.
    const stamp = heavyStepStampPath(projectId)
    await fs.mkdir(path.dirname(stamp), { recursive: true })
    await fs.writeFile(stamp, String(Date.now()))
    expect(await heavyStepsDue(projectId)).toBe(false)
  })

  test('stamp older than the cooldown re-runs and refreshes the claim', async () => {
    const projectId = freshProjectId()
    const stamp = heavyStepStampPath(projectId)
    await fs.mkdir(path.dirname(stamp), { recursive: true })
    await fs.writeFile(stamp, 'stale')
    const stale = new Date(Date.now() - 11 * 60 * 1000)
    await fs.utimes(stamp, stale, stale)
    const before = Date.now()
    expect(await heavyStepsDue(projectId)).toBe(true)
    const stat = await fs.stat(stamp)
    expect(stat.mtimeMs).toBeGreaterThanOrEqual(before)
  })

  test('stamp is per project, not global', async () => {
    const projectA = freshProjectId()
    const projectB = freshProjectId()
    expect(await heavyStepsDue(projectA)).toBe(true)
    // A's claim must not suppress B.
    expect(await heavyStepsDue(projectB)).toBe(true)
  })

  test('concurrent cold claims allow exactly one heavy worker', async () => {
    const projectId = freshProjectId()
    const claims = await Promise.all(Array.from({ length: 8 }, () => heavyStepsDue(projectId)))
    expect(claims.filter(Boolean)).toHaveLength(1)
  })
})
