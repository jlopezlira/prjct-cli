/**
 * Schema v2 — GTD queue in the typed `queue_tasks` table.
 * Covers the rewrite (row-level CRUD, indexed per-prompt reads, sync upsert)
 * and migration 53 (backfill the kv_store blob incl. extended fields, retire
 * the key).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'
import { prjctDb } from '../../storage/database'
import { migrations } from '../../storage/database/migrations'
import { openDatabase } from '../../storage/database/sqlite-compat'
import { queueStorage } from '../../storage/queue-storage'

const fixture: {
  tmpRoot: string
} = {
  tmpRoot: '',
}
const pid = 'test-queue-typed'
const origGlobal = pathManager.getGlobalProjectPath.bind(pathManager)
const origFile = pathManager.getFilePath.bind(pathManager)

describe('queue-storage — typed table (Schema v2)', () => {
  beforeEach(async () => {
    prjctDb.close()
    fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-queue-'))
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

  it('add → getActiveTasks/getBacklog are indexed row reads (the per-prompt hot path)', async () => {
    await queueStorage.addTask(pid, {
      description: 'active one',
      priority: 'high',
      type: 'feature',
      section: 'active',
    })
    await queueStorage.addTask(pid, {
      description: 'backlog one',
      priority: 'low',
      type: 'bug',
      section: 'backlog',
    })

    const active = await queueStorage.getActiveTasks(pid)
    expect(active).toHaveLength(1)
    expect(active[0].description).toBe('active one')
    const backlog = await queueStorage.getBacklog(pid)
    expect(backlog).toHaveLength(1)
    expect((await queueStorage.getNextTask(pid))?.description).toBe('active one')
  })

  it('completeTask flips the row once and excludes it from active', async () => {
    const t = await queueStorage.addTask(pid, {
      description: 'do it',
      priority: 'medium',
      type: 'feature',
      section: 'active',
    })
    const done = await queueStorage.completeTask(pid, t.id)
    expect(done?.completed).toBe(true)
    expect(done?.completedAt).toBeTruthy()
    expect(await queueStorage.completeTask(pid, t.id)).toBeNull() // already completed → no-op
    expect(await queueStorage.getActiveTasks(pid)).toHaveLength(0)
  })

  it('updateTask/moveToSection/setPriority mutate single rows; extended fields round-trip', async () => {
    const t = await queueStorage.addTask(pid, {
      description: 'refine',
      priority: 'low',
      type: 'feature',
      section: 'backlog',
      body: '## details',
      agent: 'fe',
      groupName: 'Reports',
    })
    await queueStorage.moveToSection(pid, t.id, 'active')
    await queueStorage.setPriority(pid, t.id, 'high')
    const updated = await queueStorage.updateTask(pid, t.id, { description: 'refined' })
    expect(updated?.description).toBe('refined')

    const row = await queueStorage.getTask(pid, t.id)
    expect(row?.section).toBe('active')
    expect(row?.priority).toBe('high')
    expect(row?.body).toBe('## details')
    expect(row?.agent).toBe('fe')
    expect(row?.groupName).toBe('Reports')
  })

  it('upsertTask (sync pull) inserts once and merges on re-apply — no duplicates', async () => {
    await queueStorage.upsertTask(pid, { id: 'q1', description: 'from cloud', priority: 'high' })
    await queueStorage.upsertTask(pid, { id: 'q1', description: 'from cloud v2' })
    const all = await queueStorage.getTasks(pid)
    expect(all).toHaveLength(1)
    expect(all[0].description).toBe('from cloud v2')
    expect(all[0].priority).toBe('high') // local field survived the merge
  })

  it('deleteByFeatureId removes only matching rows and reports the count', async () => {
    await queueStorage.addTasks(pid, [
      {
        description: 'a',
        priority: 'medium',
        type: 'feature',
        section: 'backlog',
        featureId: 'f1',
      },
      {
        description: 'b',
        priority: 'medium',
        type: 'feature',
        section: 'backlog',
        featureId: 'f1',
      },
      {
        description: 'c',
        priority: 'medium',
        type: 'feature',
        section: 'backlog',
        featureId: 'f2',
      },
    ])
    expect(await queueStorage.deleteByFeatureId(pid, 'f1')).toBe(2)
    expect(await queueStorage.getTasks(pid)).toHaveLength(1)
  })
})

describe('migration 53 — kv queue blob → typed table', () => {
  it('backfills tasks (incl. extended fields) and retires the key', () => {
    const db = openDatabase(':memory:')
    db.run(
      `CREATE TABLE queue_tasks (
         id TEXT PRIMARY KEY, description TEXT NOT NULL, type TEXT, priority TEXT, section TEXT,
         created_at TEXT NOT NULL, completed INTEGER DEFAULT 0, completed_at TEXT,
         feature_id TEXT, feature_name TEXT )`
    )
    db.run(
      'CREATE TABLE kv_store (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)'
    )
    const blob = {
      tasks: [
        {
          id: 'q1',
          description: 'carry body',
          type: 'bug',
          priority: 'high',
          section: 'active',
          createdAt: '2026-06-01T00:00:00.000Z',
          completed: false,
          body: '## md body',
          agent: 'be',
          groupName: 'Audits',
          groupId: 'g9',
          featureId: 'f1',
          originFeature: 'Stock',
        },
        {
          id: 'q2',
          description: 'done one',
          createdAt: '2026-05-01T00:00:00.000Z',
          completed: true,
          completedAt: '2026-05-02T00:00:00.000Z',
        },
        { description: 'no id — skipped' },
        // The junk class that made up 6,046 of 6,105 real-blob entries:
        { id: 'q3', description: '', createdAt: '2026-06-02T00:00:00.000Z', completed: false },
      ],
      lastUpdated: '2026-06-01',
    }
    db.prepare('INSERT INTO kv_store (key, data, updated_at) VALUES (?, ?, ?)').run(
      'queue',
      JSON.stringify(blob),
      '2026-06-01'
    )

    const m53 = migrations.find((m) => m.version === 53)
    expect(m53).toBeTruthy()
    m53?.up(db)

    const rows = db.prepare('SELECT * FROM queue_tasks ORDER BY id').all() as Array<
      Record<string, unknown>
    >
    expect(rows).toHaveLength(2) // id-less AND empty-description entries skipped
    expect(rows[0].body).toBe('## md body')
    expect(rows[0].agent).toBe('be')
    expect(rows[0].group_name).toBe('Audits')
    expect(rows[0].feature_name).toBe('Stock')
    expect(rows[1].completed).toBe(1)
    const kv = db.prepare("SELECT COUNT(*) AS c FROM kv_store WHERE key = 'queue'").get() as {
      c: number
    }
    expect(kv.c).toBe(0)
    db.close()
  })
})

describe('migration 55 — kv ideas blob → typed table + orphan-key sweep', () => {
  it('backfills ideas (tags + extras on cold columns) and sweeps orphan keys', () => {
    const db = openDatabase(':memory:')
    db.run(
      `CREATE TABLE ideas (
         id TEXT PRIMARY KEY, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
         priority TEXT NOT NULL DEFAULT 'medium', tags TEXT, added_at TEXT NOT NULL,
         converted_to TEXT, details TEXT, data TEXT )`
    )
    db.run(
      'CREATE TABLE kv_store (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)'
    )
    const ins = db.prepare('INSERT INTO kv_store (key, data, updated_at) VALUES (?, ?, ?)')
    ins.run(
      'ideas',
      JSON.stringify({
        ideas: [
          {
            id: 'i1',
            text: 'great idea',
            status: 'pending',
            priority: 'high',
            tags: ['ux'],
            addedAt: '2026-06-01T00:00:00.000Z',
            painPoints: ['slow'],
          },
          { id: 'i2', text: '', addedAt: '2026-06-01T00:00:00.000Z' }, // empty text → skipped
        ],
        lastUpdated: 'x',
      }),
      'x'
    )
    ins.run('memory:patterns', '{}', 'x')
    ins.run('analysis:derived-rules:abc123', '{}', 'x')
    ins.run('project', '{}', 'x') // unrelated key must survive

    const m55 = migrations.find((m) => m.version === 55)
    expect(m55).toBeTruthy()
    m55?.up(db)

    const rows = db.prepare('SELECT * FROM ideas').all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0].priority).toBe('high')
    expect(JSON.parse(rows[0].tags as string)).toEqual(['ux'])
    expect(JSON.parse(rows[0].data as string).painPoints).toEqual(['slow'])
    const keys = (
      db.prepare('SELECT key FROM kv_store ORDER BY key').all() as Array<{ key: string }>
    ).map((k) => k.key)
    expect(keys).toEqual(['project']) // ideas + orphans swept, unrelated survives
    db.close()
  })
})

describe('migration 56 — task history: blob → typed tasks rows', () => {
  it('backfills history entries and strips taskHistory from the state blob', () => {
    const db = openDatabase(':memory:')
    db.run(
      `CREATE TABLE tasks (
         id TEXT PRIMARY KEY, description TEXT NOT NULL, type TEXT, status TEXT NOT NULL,
         branch TEXT, linear_id TEXT, pr_url TEXT, started_at TEXT NOT NULL, completed_at TEXT,
         tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0, data TEXT )`
    )
    db.run(
      'CREATE TABLE kv_store (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)'
    )
    const state = {
      currentTask: { id: 'live', description: 'still running' },
      pausedTasks: [],
      taskHistory: [
        {
          taskId: 'h1',
          title: 'shipped the thing',
          classification: 'feature',
          startedAt: '2026-06-01T00:00:00.000Z',
          completedAt: '2026-06-01T02:00:00.000Z',
          subtaskCount: 2,
          subtaskSummaries: [],
          outcome: 'done well',
          branchName: 'feat/x',
          linearId: 'PRJ-9',
          feedback: { patternsDiscovered: ['p1'] },
          tokensIn: 100,
          tokensOut: 50,
        },
        { title: 'no taskId — skipped' },
      ],
      lastUpdated: 'x',
    }
    db.prepare('INSERT INTO kv_store (key, data, updated_at) VALUES (?, ?, ?)').run(
      'state',
      JSON.stringify(state),
      'x'
    )

    const m56 = migrations.find((m) => m.version === 56)
    expect(m56).toBeTruthy()
    m56?.up(db)

    const row = db.prepare("SELECT * FROM tasks WHERE id = 'h1'").get() as Record<string, unknown>
    expect(row.status).toBe('completed')
    expect(row.type).toBe('feature')
    expect(row.linear_id).toBe('PRJ-9')
    expect(row.tokens_in).toBe(100)
    const cold = JSON.parse(row.data as string)
    expect(cold.outcome).toBe('done well')
    expect(cold.feedback.patternsDiscovered).toEqual(['p1'])
    // Blob keeps the LIVE state machine but loses taskHistory.
    const blob = JSON.parse(
      (db.prepare("SELECT data FROM kv_store WHERE key = 'state'").get() as { data: string }).data
    )
    expect(blob.currentTask.id).toBe('live')
    expect('taskHistory' in blob).toBe(false)
    db.close()
  })
})
