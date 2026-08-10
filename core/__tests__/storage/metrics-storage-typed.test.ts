/**
 * Schema v2 — sync metrics in typed tables (metrics_daily + metrics_agent_usage).
 * Covers the rewrite (upsert-per-sync, SQL-aggregate summary) and migration 52
 * (backfill the kv_store blob incl. lifetime-totals remainder, retire the key).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'
import { prjctDb } from '../../storage/database'
import { migrations } from '../../storage/database/migrations'
import { openDatabase } from '../../storage/database/sqlite-compat'
import { metricsStorage } from '../../storage/metrics-storage'

const fixture: {
  tmpRoot: string
} = {
  tmpRoot: '',
}
const pid = 'test-metrics-typed'
const origGlobal = pathManager.getGlobalProjectPath.bind(pathManager)
const origFile = pathManager.getFilePath.bind(pathManager)

describe('metrics-storage — typed tables', () => {
  beforeEach(async () => {
    prjctDb.close()
    fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-metrics-'))
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

  it('recordSync upserts the metrics_daily row product.ts SUMs (the read-never-written bug)', async () => {
    await metricsStorage.recordSync(pid, { originalSize: 1000, filteredSize: 400, duration: 120 })
    await metricsStorage.recordSync(pid, { originalSize: 500, filteredSize: 250, duration: 80 })

    // The exact aggregates `prjct product` runs — were permanently 0 before.
    const syncs = prjctDb.get<{ v: number }>(
      pid,
      'SELECT COALESCE(SUM(syncs), 0) AS v FROM metrics_daily'
    )?.v
    const tokens = prjctDb.get<{ v: number }>(
      pid,
      'SELECT COALESCE(SUM(tokens_saved), 0) AS v FROM metrics_daily'
    )?.v
    expect(syncs).toBe(2)
    expect(tokens).toBe(600 + 250)
  })

  it('getSummary aggregates via SQL (totals, weighted rate, top agents)', async () => {
    await metricsStorage.recordSync(pid, {
      originalSize: 1000,
      filteredSize: 0,
      duration: 100,
      agents: ['scout', 'ranker'],
    })
    await metricsStorage.recordSync(pid, {
      originalSize: 1000,
      filteredSize: 500,
      duration: 300,
      agents: ['scout'],
    })

    const s = await metricsStorage.getSummary(pid)
    expect(s.syncCount).toBe(2)
    expect(s.totalTokensSaved).toBe(1500)
    expect(s.avgSyncDuration).toBe(200)
    expect(s.compressionRate).toBeCloseTo(0.75, 5) // (1.0 + 0.5) / 2
    expect(s.topAgents[0].agentName).toBe('scout')
    expect(s.topAgents[0].usageCount).toBe(2)
    expect(s.last30DaysTokens).toBe(1500)
  })

  it('getDailyStats returns typed rows; getFirstSyncDate is MIN(date)', async () => {
    await metricsStorage.recordSync(pid, { originalSize: 100, filteredSize: 50, duration: 10 })
    const daily = await metricsStorage.getDailyStats(pid, 7)
    expect(daily).toHaveLength(1)
    expect(daily[0].tokensSaved).toBe(50)
    expect(await metricsStorage.getFirstSyncDate(pid)).toBe(daily[0].date)
  })
})

describe('migration 52 — kv metrics blob → typed tables', () => {
  it('backfills daily rows + agent usage, preserves lifetime totals, retires the key', () => {
    const db = openDatabase(':memory:')
    db.run(
      `CREATE TABLE metrics_daily (
         date TEXT PRIMARY KEY, tokens_saved INTEGER NOT NULL DEFAULT 0,
         syncs INTEGER NOT NULL DEFAULT 0, avg_compression_rate REAL NOT NULL DEFAULT 0,
         total_duration INTEGER NOT NULL DEFAULT 0 )`
    )
    db.run(
      'CREATE TABLE kv_store (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)'
    )
    // Blob shape: lifetime totals EXCEED the (90-day-trimmed) daily sum — the
    // pre-history remainder must be preserved via a synthetic row.
    const blob = {
      totalTokensSaved: 1000,
      syncCount: 12,
      totalSyncDuration: 5000,
      avgCompressionRate: 0.4,
      firstSync: '2026-01-15T10:00:00.000Z',
      dailyStats: [
        {
          date: '2026-06-20',
          tokensSaved: 300,
          syncs: 4,
          avgCompressionRate: 0.5,
          totalDuration: 2000,
        },
      ],
      agentUsage: [{ agentName: 'scout', usageCount: 7, tokensSaved: 420 }],
    }
    db.prepare('INSERT INTO kv_store (key, data, updated_at) VALUES (?, ?, ?)').run(
      'metrics',
      JSON.stringify(blob),
      '2026-06-20'
    )

    const m52 = migrations.find((m) => m.version === 52)
    expect(m52).toBeTruthy()
    m52?.up(db)

    // Lifetime totals reproduce exactly via SUM (daily + remainder rows).
    const sums = db
      .prepare(
        'SELECT SUM(tokens_saved) AS t, SUM(syncs) AS s, SUM(total_duration) AS d FROM metrics_daily'
      )
      .get() as { t: number; s: number; d: number }
    expect(sums.t).toBe(1000)
    expect(sums.s).toBe(12)
    expect(sums.d).toBe(5000)
    // Remainder row landed on the firstSync date.
    const pre = db
      .prepare("SELECT tokens_saved, syncs FROM metrics_daily WHERE date = '2026-01-15'")
      .get() as { tokens_saved: number; syncs: number }
    expect(pre.tokens_saved).toBe(700)
    expect(pre.syncs).toBe(8)
    // Agent usage normalized.
    const agent = db
      .prepare(
        "SELECT usage_count, tokens_saved FROM metrics_agent_usage WHERE agent_name = 'scout'"
      )
      .get() as { usage_count: number; tokens_saved: number }
    expect(agent.usage_count).toBe(7)
    expect(agent.tokens_saved).toBe(420)
    // Blob retired.
    const kv = db.prepare("SELECT COUNT(*) AS c FROM kv_store WHERE key = 'metrics'").get() as {
      c: number
    }
    expect(kv.c).toBe(0)
    db.close()
  })
})
