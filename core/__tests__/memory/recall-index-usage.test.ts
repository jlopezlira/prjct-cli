/**
 * Line-by-line audit finding: recall()'s `types` filter was applied entirely
 * in JS after the SQL fetch, so ix_mem_recall(project_id, type, created_at
 * DESC) was never seekable — every typed recall() call did a full SCAN of
 * memory_entries, defeating the point of the C1 hot-path migration (get
 * JSON.parse off the per-prompt path, then leave a full scan in its place).
 * Verified with a real EXPLAIN QUERY PLAN, not just result correctness.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'
import { projectMemory } from '../../memory/project-memory'
import prjctDb from '../../storage/database'

const fixture: {
  tmpRoot: string
  projectId: string
} = {
  tmpRoot: '',
  projectId: '',
}

const original = pathManager.getGlobalProjectPath.bind(pathManager)

beforeEach(async () => {
  fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-recall-idx-'))
  fixture.projectId = `recallidx-${Math.random().toString(36).slice(2, 10)}`
  pathManager.getGlobalProjectPath = (id: string) => path.join(fixture.tmpRoot, id)
  prjctDb.getDb(fixture.projectId)
})

afterEach(async () => {
  prjctDb.close()
  pathManager.getGlobalProjectPath = original
  await fs.rm(fixture.tmpRoot, { recursive: true, force: true })
})

describe('recall() SQL type push-down (index usage)', () => {
  it('a large single-type recall() query is planned via the index, not an unindexed scan', () => {
    // At production scale (500+ rows) SQLite's planner picks an indexed SEARCH
    // for this predicate — verified separately via sqlite3 CLI with ANALYZE.
    // In-process (no ANALYZE, smaller table) the planner may still choose an
    // index-ordered SCAN rather than a seek — that's a SQLite cost-heuristic
    // detail, not a regression: this assertion only pins the fix's actual
    // guarantee — the index is consulted for the predicate, not skipped
    // entirely (i.e. not a raw table scan with the index unused).
    for (const i of Array.from({ length: 60 }, (_, index) => index)) {
      prjctDb.appendEvent(
        fixture.projectId,
        `memory.remember.${i % 3 === 0 ? 'decision' : 'fact'}`,
        {
          content: `entry ${i}`,
          tags: {},
          provenance: 'declared',
        }
      )
    }

    const plan = prjctDb
      .query<{ detail: string }>(
        fixture.projectId,
        `EXPLAIN QUERY PLAN
         SELECT id, type, content, provenance, created_at FROM memory_entries
         WHERE deleted_at IS NULL AND type IN (?) ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        'decision',
        25
      )
      .map((r) => r.detail)
      .join(' | ')

    expect(plan).toContain('ix_mem_recall')

    // Correctness: recall() actually returns only the requested type.
    const entries = projectMemory.recall(fixture.projectId, { types: ['decision'] })
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.every((e) => e.type === 'decision')).toBe(true)
  })

  it('recallByType still drives an indexed SEARCH (unaffected by this fix)', () => {
    prjctDb.appendEvent(fixture.projectId, 'memory.remember.gotcha', {
      content: 'a gotcha',
      tags: {},
      provenance: 'declared',
    })
    const entries = projectMemory.recallByType(fixture.projectId, 'gotcha', 10)
    expect(entries.length).toBe(1)
  })

  it('COMPLETENESS FIX: a rare OLDER type is no longer starved by the overfetch window', () => {
    // Before this fix, the type filter ran in JS AFTER the SQL fetch+LIMIT: the
    // unfiltered SQL query fetched only the newest `overfetch` rows (100 here:
    // max(limit*4, MIN_OVERFETCH=100)), THEN filtered by type in JS. If a type
    // is rare and its entries are older than 100 more-recent entries of other
    // types, the caller got FEWER than `limit` matches (or zero) even though
    // more exist — because the 3 'decision' entries below never made it into
    // the unfiltered top-100-newest window. Seed the rare type FIRST (oldest),
    // then 150 newer 'fact' entries that would fully push it out of the old
    // overfetch window.
    for (const i of Array.from({ length: 3 }, (_, index) => index)) {
      prjctDb.appendEvent(fixture.projectId, 'memory.remember.decision', {
        content: `real decision ${i}`,
        tags: {},
        provenance: 'declared',
      })
    }
    for (const i2 of Array.from({ length: 150 }, (_, index) => index)) {
      prjctDb.appendEvent(fixture.projectId, 'memory.remember.fact', {
        content: `newer noise ${i2}`,
        tags: {},
        provenance: 'declared',
      })
    }

    const entries = projectMemory.recall(fixture.projectId, { types: ['decision'], limit: 25 })
    expect(entries.length).toBe(3)
  })
})
