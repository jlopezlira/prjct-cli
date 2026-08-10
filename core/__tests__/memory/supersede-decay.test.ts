/**
 * projectMemory.recall — author-declared compaction (supersede / duplicate).
 *
 * Stale entries the author explicitly retired must drop out of recall so the
 * agent isn't handed an obsolete decision next to the one that replaced it.
 * Author-declared, not heuristic: nothing is pruned unless the relationship
 * was written down. The link/index layer can opt out so retired entries stay
 * resolvable (their wikilinks must not rot).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { projectMemory } from '../../memory/project-memory'
import prjctDb from '../../storage/database'
import { patchPathManager, restorePathManager } from '../_setup/path-manager-mock'

const fixture: {
  tmpRoot: string
  projectId: string
} = {
  tmpRoot: '',
  projectId: '',
}

function write(type: string, content: string, tags: Record<string, string> = {}): string {
  prjctDb.appendEvent(fixture.projectId, `memory.remember.${type}`, {
    content,
    tags,
    provenance: 'declared',
  })
  // Keep pruning/dedupe OFF here so we always get the id of the entry we
  // just wrote, even when it self-declares `superseded-by`.
  const latest = projectMemory.recall(fixture.projectId, {
    limit: 1,
    dedupeByKey: false,
    pruneSuperseded: false,
  })
  return latest[0]?.id ?? ''
}

const ids = (entries: { id: string }[]) => entries.map((e) => e.id)

beforeEach(async () => {
  fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-supersede-'))
  fixture.projectId = `test-sup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  patchPathManager(fixture.tmpRoot)
})

afterEach(async () => {
  restorePathManager()
  await fs.rm(fixture.tmpRoot, { recursive: true, force: true }).catch(() => {})
})

describe('projectMemory.recall — supersede/duplicate compaction', () => {
  it('drops an entry retired by a newer `supersedes:` entry', () => {
    const old = write('decision', 'use npm')
    write('decision', 'use bun instead', { supersedes: old })
    const got = ids(projectMemory.recall(fixture.projectId, { types: ['decision'] }))
    expect(got).not.toContain(old)
    expect(got.length).toBe(1)
  })

  it('drops an entry that self-declares `superseded-by:`', () => {
    const a = write('decision', 'legacy approach', { 'superseded-by': 'mem_99999' })
    const got = ids(projectMemory.recall(fixture.projectId, { types: ['decision'] }))
    expect(got).not.toContain(a)
  })

  it('drops an entry retired via `duplicates:`', () => {
    const orig = write('gotcha', 'WAL lock under iCloud')
    write('gotcha', 'iCloud sync lock (dupe)', { duplicates: orig })
    const got = ids(projectMemory.recall(fixture.projectId, { types: ['gotcha'] }))
    expect(got).not.toContain(orig)
  })

  it('keeps retired entries when pruneSuperseded:false (link/index layer)', () => {
    const old = write('decision', 'use npm')
    write('decision', 'use bun instead', { supersedes: old })
    const got = ids(
      projectMemory.recall(fixture.projectId, { types: ['decision'], pruneSuperseded: false })
    )
    expect(got).toContain(old)
    expect(got.length).toBe(2)
  })

  it('leaves unrelated entries untouched', () => {
    write('decision', 'alpha')
    write('decision', 'beta')
    const got = projectMemory.recall(fixture.projectId, { types: ['decision'] })
    expect(got.length).toBe(2)
  })
})

describe('projectMemory.searchFts — superseded entries never surface', () => {
  function seedMirror(
    id: string,
    type: string,
    content: string,
    tags: Record<string, string> = {}
  ): void {
    // Single-source: seed memory_entries (read by searchFts) + its tag child
    // table (read by the supersede-prune). FTS trigger indexes on insert.
    const createdMs = Date.now()
    prjctDb.run(
      fixture.projectId,
      `INSERT OR REPLACE INTO memory_entries
         (id, project_id, type, title, content, provenance, content_hash,
          user_triggered, revision_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'declared', ?, 0, 0, ?, ?)`,
      id,
      fixture.projectId,
      type,
      content.slice(0, 80),
      content,
      `hash_${id}`,
      createdMs,
      createdMs
    )
    prjctDb.run(fixture.projectId, 'DELETE FROM memory_entry_tags WHERE entry_id = ?', id)
    for (const [k, v] of Object.entries(tags)) {
      prjctDb.run(
        fixture.projectId,
        'INSERT OR IGNORE INTO memory_entry_tags (entry_id, key, value, is_machine) VALUES (?, ?, ?, 0)',
        id,
        k,
        String(v)
      )
    }
  }

  it('drops an entry retired by a superseding entry that BM25 would not co-return', () => {
    // The superseding entry shares NO keywords with the stale one — the
    // exact case recall's window-scoped prune cannot catch.
    seedMirror('mem_1', 'gotcha', 'the widget api requires manual flush', {})
    seedMirror('mem_2', 'decision', 'migrated renderer to declarative pipeline', {
      supersedes: 'mem_1',
    })
    const got = projectMemory.searchFts(fixture.projectId, ['widget'], 5)
    expect(got.map((e) => e.id)).not.toContain('mem_1')
  })

  it('drops an entry that self-declares superseded-by', () => {
    seedMirror('mem_3', 'decision', 'cache responses in redis', {
      'superseded-by': 'mem_9',
    })
    seedMirror('mem_4', 'decision', 'cache responses locally', {})
    const got = projectMemory.searchFts(fixture.projectId, ['cache'], 5)
    const ids2 = got.map((e) => e.id)
    expect(ids2).not.toContain('mem_3')
    expect(ids2).toContain('mem_4')
  })

  it('live entries still surface, with accented-keyword queries deburred', () => {
    seedMirror('mem_5', 'gotcha', 'semantic search needs normalized vectors', {})
    const got = projectMemory.searchFts(fixture.projectId, ['semántic'], 5)
    expect(got.map((e) => e.id)).toContain('mem_5')
  })
})
