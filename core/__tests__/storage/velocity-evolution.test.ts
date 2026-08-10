/**
 * Velocity restored (Schema v2) + developer-evolution snapshots.
 * Velocity sprints are COMPUTED from typed delivery tables (tasks + ships)
 * and persisted in `velocity_sprints`; developer snapshots roll profile +
 * delivery into one typed row per week with a generated summary.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'
import {
  captureDeveloperSnapshot,
  getDeveloperEvolution,
  renderDeveloperEvolution,
} from '../../services/developer-evolution'
import { prjctDb } from '../../storage/database'
import { shippedStorage } from '../../storage/shipped-storage'
import { epochWeek, velocityStorage } from '../../storage/velocity-storage'

const fixture: {
  tmpRoot: string
} = {
  tmpRoot: '',
}
const pid = 'test-velocity-evo'
const origGlobal = pathManager.getGlobalProjectPath.bind(pathManager)
const origFile = pathManager.getFilePath.bind(pathManager)
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000).toISOString()

describe('velocity — computed weekly sprints from typed delivery data', () => {
  beforeEach(async () => {
    prjctDb.close()
    fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-velo-'))
    pathManager.getGlobalProjectPath = (id: string) => path.join(fixture.tmpRoot, id)
    pathManager.getFilePath = (id: string, layer: string, filename: string) =>
      path.join(fixture.tmpRoot, id, layer, filename)
    await fs.mkdir(path.join(fixture.tmpRoot, pid, 'sync'), { recursive: true })
    await fs.writeFile(path.join(fixture.tmpRoot, pid, 'sync', 'pending.json'), '[]', 'utf-8')
    prjctDb.getDb(pid)
  })

  afterEach(async () => {
    prjctDb.close()
    pathManager.getGlobalProjectPath = origGlobal
    pathManager.getFilePath = origFile
    if (fixture.tmpRoot) await fs.rm(fixture.tmpRoot, { recursive: true, force: true })
  })

  it('recompute derives sprints from ships + completed tasks and persists typed rows', async () => {
    // Anchor timestamps INSIDE one epoch week: relative offsets like
    // "1/2 days ago" straddle the fixed Thursday-UTC week boundary and made
    // this flake on CI (2 points landing one week, 1 in another).
    const WEEK_MS = 7 * 24 * 60 * 60 * 1000
    const weekStart = Math.floor(Date.now() / WEEK_MS) * WEEK_MS
    const inWeek = (h: number) => new Date(weekStart + h * 3600000).toISOString()

    // Two ships this week, one three weeks back.
    await shippedStorage.addShipped(pid, { name: 'a', version: '1.0.0' }, inWeek(2))
    await shippedStorage.addShipped(pid, { name: 'b', version: '1.1.0' }, inWeek(4))
    await shippedStorage.addShipped(
      pid,
      { name: 'old', version: '0.9.0' },
      new Date(weekStart - 3 * WEEK_MS + 3600000).toISOString()
    )
    // One completed work cycle this week (typed tasks mirror).
    prjctDb.run(
      pid,
      "INSERT INTO tasks (id, description, status, started_at, completed_at) VALUES ('t1', 'done thing', 'completed', ?, ?)",
      inWeek(1),
      inWeek(6)
    )

    await velocityStorage.recompute(pid)

    const m = await velocityStorage.getMetrics(pid)
    expect(m.sprints.length).toBeGreaterThanOrEqual(2)
    const thisWeek = m.sprints.find((s) => s.sprintNumber === epochWeek(inWeek(2)))
    expect(thisWeek?.pointsCompleted).toBe(3) // 2 ships + 1 task
    expect(thisWeek?.tasksCompleted).toBe(1)
    expect(m.averageVelocity).toBeGreaterThan(0)
  })

  it('recompute is idempotent (upsert per sprint week)', async () => {
    const WEEK_MS = 7 * 24 * 60 * 60 * 1000
    const at = new Date(Math.floor(Date.now() / WEEK_MS) * WEEK_MS + 3600000).toISOString()
    await shippedStorage.addShipped(pid, { name: 'x', version: '1.0.0' }, at)
    await velocityStorage.recompute(pid)
    await velocityStorage.recompute(pid)
    const rows = prjctDb.get<{ c: number }>(
      pid,
      'SELECT COUNT(*) AS c FROM velocity_sprints WHERE sprint_number = ?',
      epochWeek(at)
    )
    expect(rows?.c).toBe(1)
  })

  it('developer snapshot: one typed row per week, generated summary, evolution readable', async () => {
    await shippedStorage.addShipped(pid, { name: 'ship', version: '2.0.0' }, iso(1))
    await velocityStorage.recompute(pid)

    const first = await captureDeveloperSnapshot(pid)
    expect(first).toBe(true)
    const again = await captureDeveloperSnapshot(pid)
    expect(again).toBe(false) // idempotent within the week

    const evo = getDeveloperEvolution(pid)
    expect(evo).toHaveLength(1)
    expect(evo[0].ships7d).toBe(1)
    expect(evo[0].velocityAvg).toBeGreaterThan(0)
    expect(evo[0].summary).toContain('shipped 1')
    expect(evo[0].summary).toContain('standing preferences')

    const md = renderDeveloperEvolution(pid)
    expect(md).toContain('## Evolution (weekly snapshots)')
    expect(md).toContain('Week digest')
  })
})

describe('estimation loop — expected vs actual points', () => {
  it('computes accuracy + under-estimation patterns from completed tasks', async () => {
    // Accurate: expected 2, actual 2 (same step).
    prjctDb.run(
      pid,
      `INSERT INTO tasks (id, description, status, started_at, completed_at, data)
       VALUES ('e1', 'small fix', 'completed', ?, ?, json('{"expectedPoints":2,"actualPoints":2,"diffLines":80}'))`,
      iso(2),
      iso(1)
    )
    // Badly under-estimated: expected 2 (step 1), actual 8 (step 3) — drift 2.
    prjctDb.run(
      pid,
      `INSERT INTO tasks (id, description, type, status, started_at, completed_at, data)
       VALUES ('e2', 'runaway refactor', 'refactor', 'completed', ?, ?, json('{"expectedPoints":2,"actualPoints":8,"diffLines":900}'))`,
      iso(2),
      iso(1)
    )

    const m = await velocityStorage.getMetrics(pid).catch(() => null)
    // getMetrics needs at least one sprint row — recompute from the tasks.
    await velocityStorage.recompute(pid)
    const metrics = await velocityStorage.getMetrics(pid)
    expect(metrics.estimationAccuracy).toBe(50) // 1 of 2 within ±1 step
    expect(metrics.underEstimated).toHaveLength(1)
    expect(metrics.underEstimated[0].category).toBe('refactor')
    expect(metrics.underEstimated[0].avgVariance).toBeGreaterThan(0) // actual > expected
    void m
  })
})
