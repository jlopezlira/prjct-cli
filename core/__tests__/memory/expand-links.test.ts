/**
 * projectMemory.expandWithLinks — one-hop relationship-graph traversal.
 *
 * The cross-reference graph (`resolves=`/`relates=`/`supersedes=` tags and
 * inline `mem_N` mentions) existed only as rendered wikilinks; no retrieval
 * path followed it. These tests pin that recalling an entry can now surface
 * the entries it points to — deduped against the seed and capped.
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

/** Write a memory entry and return its `mem_<rowid>` id. */
function write(type: string, content: string, tags: Record<string, string> = {}): string {
  prjctDb.appendEvent(fixture.projectId, `memory.remember.${type}`, {
    content,
    tags,
    provenance: 'declared',
  })
  // Newest-first recall → the entry we just wrote is first.
  const latest = projectMemory.recall(fixture.projectId, { limit: 1, dedupeByKey: false })
  return latest[0]?.id ?? ''
}

beforeEach(async () => {
  fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-expand-links-'))
  fixture.projectId = `test-expand-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  patchPathManager(fixture.tmpRoot)
})

afterEach(async () => {
  restorePathManager()
  await fs.rm(fixture.tmpRoot, { recursive: true, force: true }).catch(() => {})
})

describe('projectMemory.expandWithLinks', () => {
  it('follows a `resolves=` tag to the referenced entry', () => {
    const a = write('decision', 'use npm as the package manager')
    const b = write('decision', 'switched to bun for speed', { resolves: a })
    const seed = projectMemory.getById(fixture.projectId, b)!
    const linked = projectMemory.expandWithLinks(fixture.projectId, [seed])
    expect(linked.map((e) => e.id)).toContain(a)
  })

  it('follows an inline `mem_N` mention in the content body', () => {
    const a = write('gotcha', 'WAL mode locks under iCloud sync')
    const c = write('learning', `root cause traced back to ${a} — same locking class`)
    const seed = projectMemory.getById(fixture.projectId, c)!
    const linked = projectMemory.expandWithLinks(fixture.projectId, [seed])
    expect(linked.map((e) => e.id)).toContain(a)
  })

  it('never returns an entry already in the seed set (no self/dup)', () => {
    const a = write('decision', 'alpha')
    const b = write('decision', 'beta resolves alpha', { resolves: a })
    const seedA = projectMemory.getById(fixture.projectId, a)!
    const seedB = projectMemory.getById(fixture.projectId, b)!
    const linked = projectMemory.expandWithLinks(fixture.projectId, [seedA, seedB])
    // Both are already seeds — nothing new to surface.
    expect(linked).toHaveLength(0)
  })

  it('respects the cap', () => {
    const targets = [write('fact', 'one'), write('fact', 'two'), write('fact', 'three')]
    const hub = write('decision', `relates to ${targets.join(' and ')}`)
    const seed = projectMemory.getById(fixture.projectId, hub)!
    const linked = projectMemory.expandWithLinks(fixture.projectId, [seed], 2)
    expect(linked.length).toBe(2)
  })

  it('returns [] for an empty seed or a non-positive cap', () => {
    expect(projectMemory.expandWithLinks(fixture.projectId, [])).toHaveLength(0)
    const a = write('fact', 'solo')
    const seed = projectMemory.getById(fixture.projectId, a)!
    expect(projectMemory.expandWithLinks(fixture.projectId, [seed], 0)).toHaveLength(0)
  })
})
