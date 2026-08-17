/**
 * Cold purge: soft-deleted vacuum, orphan events, auto-source cap.
 * Runs on prjct sync — makes "delete" actually free disk over time.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { projectMemory } from '../../memory/project-memory'
import {
  isAutoSource,
  purgeOrphanRememberEvents,
  purgeSoftDeleted,
  runVaultPurge,
  trimAutoSourceCap,
  vaultHealth,
} from '../../services/retention/purge'
import prjctDb from '../../storage/database'
import { patchPathManager, restorePathManager } from '../_setup/path-manager-mock'

const fixture: {
  tmpRoot: string
  projectId: string
} = {
  tmpRoot: '',
  projectId: '',
}

beforeEach(async () => {
  fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-purge-'))
  fixture.projectId = `test-purge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  patchPathManager(fixture.tmpRoot)
  prjctDb.run(fixture.projectId, 'SELECT 1 WHERE 1=0')
})

afterEach(async () => {
  restorePathManager()
  await fs.rm(fixture.tmpRoot, { recursive: true, force: true }).catch(() => {})
})

describe('isAutoSource', () => {
  it('matches known auto prefixes', () => {
    expect(isAutoSource('pattern-detector-auto')).toBe(true)
    expect(isAutoSource('transcript-auto')).toBe(true)
    expect(isAutoSource('skill-miss-detector')).toBe(true)
    expect(isAutoSource('friction-detector')).toBe(true)
    expect(isAutoSource('land-auto')).toBe(true)
    expect(isAutoSource(undefined)).toBe(false)
    expect(isAutoSource('manual-review')).toBe(false)
  })
})

describe('purgeSoftDeleted', () => {
  it('hard-deletes rows with old deleted_at and leaves live rows', () => {
    const old = Date.now() - 60 * 86_400_000
    const recent = Date.now() - 2 * 86_400_000
    prjctDb.run(
      fixture.projectId,
      `INSERT INTO memory_entries (
        id, project_id, type, title, content, provenance, content_hash,
        user_triggered, revision_count, created_at, updated_at, deleted_at
      ) VALUES
        ('mem_9001', ?, 'context', 'old', 'old deleted content here for purge test xx', 'extracted', 'h1', 0, 0, ?, ?, ?),
        ('mem_9002', ?, 'context', 'new', 'recently deleted content still in grace period xx', 'extracted', 'h2', 0, 0, ?, ?, ?),
        ('mem_9003', ?, 'decision', 'live', 'live decision that must never be purged by soft-delete vacuum', 'declared', 'h3', 0, 0, ?, ?, NULL)`,
      fixture.projectId,
      old,
      old,
      old,
      fixture.projectId,
      recent,
      recent,
      recent,
      fixture.projectId,
      Date.now(),
      Date.now()
    )

    const n = purgeSoftDeleted(fixture.projectId, 30, 100)
    expect(n).toBe(1)
    const gone = prjctDb.get<{ c: number }>(
      fixture.projectId,
      "SELECT COUNT(*) AS c FROM memory_entries WHERE id = 'mem_9001'"
    )
    expect(gone?.c).toBe(0)
    const grace = prjctDb.get<{ c: number }>(
      fixture.projectId,
      "SELECT COUNT(*) AS c FROM memory_entries WHERE id = 'mem_9002'"
    )
    expect(grace?.c).toBe(1)
    const live = prjctDb.get<{ c: number }>(
      fixture.projectId,
      "SELECT COUNT(*) AS c FROM memory_entries WHERE id = 'mem_9003' AND deleted_at IS NULL"
    )
    expect(live?.c).toBe(1)
  })
})

describe('trimAutoSourceCap', () => {
  it('soft-deletes oldest auto-source rows beyond maxLive', async () => {
    for (const i of Array.from({ length: 5 }, (_, index) => index)) {
      await projectMemory.remember(fixture.tmpRoot, {
        type: 'learning',
        content: `auto pattern finding number ${i} with enough characters to pass length gates xx`,
        tags: { source: 'pattern-detector-auto' },
        projectId: fixture.projectId,
        // Bypass capture gate for setup — gate may reject low excess
        // by using unique content above; still may hit gate. Force via SQL if needed.
      })
    }
    // If gate blocked some, seed via SQL
    const live = projectMemory
      .allEntriesForIndex(fixture.projectId)
      .filter((e) => e.tags?.source === 'pattern-detector-auto')
    if (live.length < 5) {
      for (const i2 of Array.from({ length: 5 - live.length }, (_, index) => index + live.length)) {
        const id = `mem_8${100 + i2}`
        const t = Date.now() - (5 - i2) * 86_400_000
        prjctDb.run(
          fixture.projectId,
          `INSERT INTO memory_entries (
            id, project_id, type, title, content, provenance, content_hash,
            user_triggered, revision_count, created_at, updated_at, deleted_at
          ) VALUES (?, ?, 'learning', 'p', ?, 'inferred', ?, 0, 0, ?, ?, NULL)`,
          id,
          fixture.projectId,
          `forced auto pattern seed ${i2} unique body for cap test ${Math.random()}`,
          `hash-auto-${i2}`,
          t,
          t
        )
        prjctDb.run(
          fixture.projectId,
          'INSERT INTO memory_entry_tags (entry_id, key, value, is_machine) VALUES (?, ?, ?, 0)',
          id,
          'source',
          'pattern-detector-auto'
        )
      }
    }

    const trimmed = trimAutoSourceCap(fixture.projectId, 2)
    expect(trimmed).toBeGreaterThanOrEqual(1)
    const after = projectMemory
      .allEntriesForIndex(fixture.projectId)
      .filter((e) => e.tags?.source === 'pattern-detector-auto')
    expect(after.length).toBeLessThanOrEqual(2)
  })
})

describe('vaultHealth + runVaultPurge', () => {
  it('reports inventory and dry-run purges nothing', async () => {
    await projectMemory.remember(fixture.tmpRoot, {
      type: 'decision',
      content: 'we only keep model knowledge durable everything else ages out of the vault',
      projectId: fixture.projectId,
    })
    const h = vaultHealth(fixture.projectId)
    expect(h.live).toBeGreaterThanOrEqual(1)
    const dry = await runVaultPurge(fixture.projectId, { dryRun: true })
    expect(dry.softDeletedPurged + dry.archivesPruned).toBe(0)
  })
})

describe('distill-then-hard-delete', () => {
  it('buildDistillContent collapses batch to one model residue', async () => {
    const { buildDistillContent } = await import('../../services/retention/distill')
    const batch = [
      {
        id: 'mem_1',
        type: 'learning',
        content: 'pattern detector found recurring auth bug in middleware layer again today',
        tags: { source: 'pattern-detector-auto' },
        rememberedAt: new Date().toISOString(),
        provenance: 'inferred' as const,
      },
      {
        id: 'mem_2',
        type: 'learning',
        content: 'pattern detector found recurring timeout in sync service under load',
        tags: { source: 'pattern-detector-auto' },
        rememberedAt: new Date().toISOString(),
        provenance: 'inferred' as const,
      },
    ]
    const text = buildDistillContent('pattern-detector-auto', batch, new Date().toISOString())
    expect(text).toMatch(/Distill of discarded/)
    expect(text).toMatch(/discarded=2/)
    expect(text).toMatch(/hard-deleted after distillation/)
    // One compact residue, not two full entry dumps glued together
    expect(text.split('pattern detector found').length).toBeLessThanOrEqual(3)
  })

  it('hardDeleteEntries removes rows for real', () => {
    const { hardDeleteEntries } =
      require('../../services/retention/distill') as typeof import('../../services/retention/distill')
    prjctDb.run(
      fixture.projectId,
      `INSERT INTO memory_entries (
        id, project_id, type, title, content, provenance, content_hash,
        user_triggered, revision_count, created_at, updated_at, deleted_at
      ) VALUES ('mem_7701', ?, 'context', 'x', 'noise body to hard delete after distill xx', 'inferred', 'hd1', 0, 0, ?, ?, NULL)`,
      fixture.projectId,
      Date.now(),
      Date.now()
    )
    expect(hardDeleteEntries(fixture.projectId, ['mem_7701'])).toBe(1)
    const c = prjctDb.get<{ c: number }>(
      fixture.projectId,
      "SELECT COUNT(*) AS c FROM memory_entries WHERE id = 'mem_7701'"
    )
    expect(c?.c).toBe(0)
  })
})

describe('purgeOrphanRememberEvents', () => {
  const insertEvent = (type: string, timestampIso: string): number =>
    Number(
      prjctDb.run(
        fixture.projectId,
        'INSERT INTO events (type, timestamp) VALUES (?, ?)',
        type,
        timestampIso
      ).lastInsertRowid
    )

  const insertEntry = (id: string, deletedAt: number | null) => {
    const now = Date.now()
    prjctDb.run(
      fixture.projectId,
      `INSERT INTO memory_entries (
        id, project_id, type, title, content, provenance, content_hash,
        user_triggered, revision_count, created_at, updated_at, deleted_at
      ) VALUES (?, ?, 'context', 't', ?, 'extracted', ?, 0, 0, ?, ?, ?)`,
      id,
      fixture.projectId,
      `entry body for ${id} in orphan event purge test`,
      `hash-${id}`,
      now,
      now,
      deletedAt
    )
  }

  const eventSurvives = (id: number): boolean =>
    (prjctDb.get<{ c: number }>(
      fixture.projectId,
      'SELECT COUNT(*) AS c FROM events WHERE id = ?',
      id
    )?.c ?? 0) === 1

  it('purges orphans, keeps events with live entries / recent / other types', () => {
    const oldIso = new Date(Date.now() - 60 * 86_400_000).toISOString()
    const recentIso = new Date(Date.now() - 86_400_000).toISOString()

    const orphan = insertEvent('memory.remember.a', oldIso)
    const withLive = insertEvent('memory.remember.b', oldIso)
    insertEntry(`mem_${withLive}`, null)
    const withSoftDeleted = insertEvent('memory.remember.c', oldIso)
    insertEntry(`mem_${withSoftDeleted}`, Date.now() - 60 * 86_400_000)
    const recentOrphan = insertEvent('memory.remember.d', recentIso)
    const otherType = insertEvent('memory.other', oldIso)

    const purged = purgeOrphanRememberEvents(fixture.projectId, 30, 100)
    expect(purged).toBe(2)
    expect(eventSurvives(orphan)).toBe(false)
    expect(eventSurvives(withSoftDeleted)).toBe(false)
    expect(eventSurvives(withLive)).toBe(true)
    expect(eventSurvives(recentOrphan)).toBe(true)
    expect(eventSurvives(otherType)).toBe(true)
  })

  it('uses idx_events_type_ts (range predicate, not a full scan)', () => {
    insertEvent('memory.remember.explain', new Date().toISOString())
    // Mirrors the query in purge.ts — keep in sync if the SQL changes.
    const plan = prjctDb.query<{ detail: string }>(
      fixture.projectId,
      `EXPLAIN QUERY PLAN SELECT e.id FROM events e
       WHERE e.type >= 'memory.remember.' AND e.type < 'memory.remember/'
         AND e.timestamp < ?
         AND NOT EXISTS (
           SELECT 1 FROM memory_entries m
           WHERE m.id = 'mem_' || e.id AND m.deleted_at IS NULL
         )
       ORDER BY e.id ASC
       LIMIT ?`,
      new Date().toISOString(),
      500
    )
    expect(plan.some((r) => r.detail.includes('idx_events_type_ts'))).toBe(true)
    expect(plan.some((r) => r.detail.includes('SCAN e'))).toBe(false)
  })
})

describe('partial index on memory_entries(deleted_at)', () => {
  it('migration applies the partial index and the purge scan uses it', () => {
    const idx = prjctDb.get<{ sql: string }>(
      fixture.projectId,
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'ix_memory_entries_deleted_at'"
    )
    expect(idx).toBeDefined()
    expect(idx?.sql).toContain('WHERE deleted_at IS NOT NULL')

    const plan = prjctDb.query<{ detail: string }>(
      fixture.projectId,
      `EXPLAIN QUERY PLAN SELECT id FROM memory_entries
       WHERE deleted_at IS NOT NULL AND deleted_at < ?
       ORDER BY deleted_at ASC
       LIMIT ?`,
      Date.now(),
      100
    )
    expect(plan.some((r) => r.detail.includes('ix_memory_entries_deleted_at'))).toBe(true)
  })
})
