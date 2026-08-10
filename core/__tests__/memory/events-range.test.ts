/**
 * Prefix-range bounds — the LIKE→range rewrite contract.
 *
 * SQLite can't drive an index from `type LIKE ?` (full SCAN, verified
 * with EXPLAIN); `type >= lo AND type < hi` is the indexed equivalent.
 * These tests pin that the range predicates select EXACTLY the same
 * rows as the LIKE patterns they replaced — including the adversarial
 * edge cases right at the bounds ('memory/', 'memory.rememberX').
 *
 * Connections go through the sqlite-compat factory (the only sanctioned
 * driver entry point — see sqlite-factory-guard.test.ts).
 */

import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MEMORY_EVENT_RANGE, REMEMBER_EVENT_RANGE } from '../../memory/events'
import { openDatabase, type SqliteDatabase } from '../../storage/database/sqlite-compat'

const TYPES = [
  'memory.remember.decision',
  'memory.remember.gotcha',
  'memory.remember.', // degenerate: bare prefix row
  'memory.rememberX', // adversarial: sorts between '.' and '/'
  'memory.remember/', // adversarial: exactly the upper bound
  'memory.post_edit',
  'memory.task.tagged',
  'memory.', // degenerate: bare prefix row
  'memory/', // adversarial: exactly the upper bound
  'memoryX',
  'other.event',
  'task.started',
]

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prjct-events-range-'))
const openDbs: SqliteDatabase[] = []
const fixture: {
  dbCounter: number
} = {
  dbCounter: 0,
}

afterAll(() => {
  for (const db of openDbs) {
    try {
      db.close()
    } catch {}
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function freshDb(): SqliteDatabase {
  const db = openDatabase(path.join(tmpDir, `events-${++fixture.dbCounter}.db`))
  openDbs.push(db)
  db.run('CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT)')
  const insert = db.prepare('INSERT INTO events (type) VALUES (?)')
  for (const t of TYPES) insert.run(t)
  return db
}

function selectTypes(db: SqliteDatabase, where: string, params: string[]): string[] {
  return (
    db.prepare(`SELECT type FROM events WHERE ${where} ORDER BY id`).all(...params) as {
      type: string
    }[]
  ).map((r) => r.type)
}

describe('event type range bounds', () => {
  test('REMEMBER_EVENT_RANGE selects exactly the LIKE rows', () => {
    const db = freshDb()
    const like = selectTypes(db, 'type LIKE ?', ['memory.remember.%'])
    const range = selectTypes(db, 'type >= ? AND type < ?', [...REMEMBER_EVENT_RANGE])
    expect(range).toEqual(like)
    expect(range).toContain('memory.remember.decision')
    expect(range).not.toContain('memory.rememberX')
    expect(range).not.toContain('memory.remember/')
  })

  test('MEMORY_EVENT_RANGE selects exactly the LIKE rows', () => {
    const db = freshDb()
    const like = selectTypes(db, 'type LIKE ?', ['memory.%'])
    const range = selectTypes(db, 'type >= ? AND type < ?', [...MEMORY_EVENT_RANGE])
    expect(range).toEqual(like)
    expect(range).not.toContain('memory/')
    expect(range).not.toContain('memoryX')
  })

  test('telemetry-only predicate (cap) matches LIKE-minus-NOT-LIKE', () => {
    const db = freshDb()
    const like = selectTypes(db, "type LIKE 'memory.%' AND type NOT LIKE 'memory.remember.%'", [])
    const range = selectTypes(db, 'type >= ? AND type < ? AND NOT (type >= ? AND type < ?)', [
      ...MEMORY_EVENT_RANGE,
      ...REMEMBER_EVENT_RANGE,
    ])
    expect(range).toEqual(like)
    expect(range).toContain('memory.post_edit')
    expect(range).not.toContain('memory.remember.decision')
  })

  test('range queries use the type index, LIKE does not', () => {
    const db = freshDb()
    db.run('CREATE INDEX idx_events_type ON events(type)')
    const planFor = (sql: string, params: string[]): string =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
        .map((r) => r.detail)
        .join(' | ')

    const rangePlan = planFor('SELECT id FROM events WHERE type >= ? AND type < ?', [
      ...REMEMBER_EVENT_RANGE,
    ])
    expect(rangePlan).toContain('idx_events_type')

    const likePlan = planFor('SELECT id FROM events WHERE type LIKE ?', ['memory.remember.%'])
    expect(likePlan).toContain('SCAN')
  })
})
