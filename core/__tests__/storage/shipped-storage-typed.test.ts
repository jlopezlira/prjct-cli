/**
 * Schema v2 C5 — ships in the typed `shipped_features` table.
 * Covers the rewrite (idempotent writes + indexed reads) and the migration
 * (dedupe the legacy kv_store blob, retire it).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'
import { prjctDb } from '../../storage/database'
import { migrations } from '../../storage/database/migrations'
import { openDatabase } from '../../storage/database/sqlite-compat'
import { shippedStorage } from '../../storage/shipped-storage'

const fixture: {
  tmpRoot: string
} = {
  tmpRoot: '',
}
const pid = 'test-shipped-typed'
const origGlobal = pathManager.getGlobalProjectPath.bind(pathManager)
const origFile = pathManager.getFilePath.bind(pathManager)
const iso = (daysAgo: number) => {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  return d.toISOString()
}

describe('shipped-storage — typed table (Schema v2 C5)', () => {
  beforeEach(async () => {
    prjctDb.close()
    fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-shipped-'))
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

  it('addShipped is idempotent on the natural key (root-cause of the 33k blob)', async () => {
    const at = iso(1)
    await shippedStorage.addShipped(pid, { name: 'rate limiter', version: '1.0.0' }, at)
    // Re-apply the SAME (name, version, shippedAt) — as a sync pull would.
    await shippedStorage.addShipped(pid, { name: 'rate limiter', version: '1.0.0' }, at)
    await shippedStorage.addShipped(pid, { name: 'rate limiter', version: '1.0.0' }, at)
    expect(await shippedStorage.getCount(pid)).toBe(1)
  })

  it('re-applying a pulled ship publishes NO new sync event (kills the ping-pong loop)', async () => {
    const at = iso(2)
    const pending = () =>
      prjctDb.get<{ c: number }>(pid, 'SELECT COUNT(*) AS c FROM sync_pending')?.c ?? 0

    const first = await shippedStorage.addShipped(pid, { name: 'sync echo', version: '1.0.0' }, at)
    const afterFirst = pending()
    expect(afterFirst).toBeGreaterThan(0) // genuine new ship → event published

    // A sync pull re-applies the same ship (same natural key, as the
    // entity-handler does). It must return the EXISTING row and publish
    // nothing — publishing a fresh id per re-apply is the feedback loop that
    // grew the legacy blob to 33k rows.
    const reapplied = await shippedStorage.addShipped(
      pid,
      { name: 'sync echo', version: '1.0.0' },
      at
    )
    expect(reapplied.id).toBe(first.id) // existing row, not a fresh UUID
    expect(pending()).toBe(afterFirst) // zero new events
  })

  it('distinct ships (same name, different version/time) are kept', async () => {
    await shippedStorage.addShipped(pid, { name: 'auth', version: '1.0.0' }, iso(3))
    await shippedStorage.addShipped(pid, { name: 'auth', version: '2.0.0' }, iso(2))
    expect(await shippedStorage.getCount(pid)).toBe(2)
  })

  it('reads are typed + bounded (getRecent limit, getByVersion, getByDateRange)', async () => {
    await shippedStorage.addShipped(pid, { name: 'a', version: '1.0.0' }, iso(30))
    await shippedStorage.addShipped(pid, { name: 'b', version: '2.0.0' }, iso(2))
    await shippedStorage.addShipped(pid, { name: 'c', version: '3.0.0' }, iso(1))

    const recent = await shippedStorage.getRecent(pid, 2)
    expect(recent.map((r) => r.name)).toEqual(['c', 'b']) // newest-first, limited

    const byVer = await shippedStorage.getByVersion(pid, '2.0.0')
    expect(byVer?.name).toBe('b')

    const range = await shippedStorage.getByDateRange(pid, new Date(iso(5)), new Date())
    expect(range.map((r) => r.name).sort()).toEqual(['b', 'c']) // excludes the 30-day-old 'a'
  })

  it('round-trips extra fields (tasks/type) through the cold data column', async () => {
    await shippedStorage.addShipped(pid, {
      name: 'export',
      version: '1.0.0',
      type: 'feature',
      tasks: ['t1', 't2'],
    })
    const [row] = await shippedStorage.getRecent(pid, 1)
    expect(row.type).toBe('feature')
    expect(row.tasks).toEqual(['t1', 't2'])
  })
})

describe('migration 51 — backfill kv_store blob → typed table, deduped', () => {
  it('dedupes the blob by natural key and retires the kv_store key', () => {
    const db = openDatabase(':memory:')
    // Minimal schema the migration touches.
    db.run(
      `CREATE TABLE shipped_features (
         id TEXT PRIMARY KEY, name TEXT NOT NULL, shipped_at TEXT NOT NULL, version TEXT NOT NULL,
         description TEXT, type TEXT, duration TEXT, data TEXT )`
    )
    db.run(
      'CREATE TABLE kv_store (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)'
    )
    // A blob with the real duplication shape: same ship re-added with new ids.
    const at = '2026-06-01T00:00:00.000Z'
    const ships = [
      { id: 'a1', name: 'ship one', version: '1.0.0', shippedAt: at },
      { id: 'a2', name: 'ship one', version: '1.0.0', shippedAt: at }, // dup (new id)
      { id: 'a3', name: 'ship one', version: '1.0.0', shippedAt: at }, // dup (new id)
      { id: 'b1', name: 'ship two', version: '2.0.0', shippedAt: at }, // distinct
    ]
    db.prepare('INSERT INTO kv_store (key, data, updated_at) VALUES (?, ?, ?)').run(
      'shipped',
      JSON.stringify({ shipped: ships, lastUpdated: at }),
      at
    )

    const m51 = migrations.find((m) => m.version === 51)
    expect(m51).toBeTruthy()
    m51?.up(db)

    const count = db.prepare('SELECT COUNT(*) AS c FROM shipped_features').get() as { c: number }
    expect(count.c).toBe(2) // 4 blob rows → 2 distinct natural keys
    const blob = db.prepare("SELECT COUNT(*) AS c FROM kv_store WHERE key = 'shipped'").get() as {
      c: number
    }
    expect(blob.c).toBe(0) // legacy blob retired
    db.close()
  })
})
