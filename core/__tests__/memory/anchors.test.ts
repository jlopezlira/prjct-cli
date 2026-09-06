/**
 * Memory anchors (phase 5): a file-tagged capture is bound to HEAD at write
 * time; the sweep marks it stale when the file is gone (and un-marks it when
 * the file is back); stale entries are served LAST and rendered with a
 * `[stale@sha]` cue. Real temp git repo, asserts on the stored row.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { markStaleMemoryAnchors, resolveAnchors, staleAnchorCount } from '../../memory/anchors'
import { enrichedRecall } from '../../memory/enriched-recall'
import { formatMemoryDigestLine, formatMemoryMd } from '../../memory/format'
import { projectMemory } from '../../memory/project-memory'
import prjctDb from '../../storage/database'
import { patchPathManager, restorePathManager } from '../_setup/path-manager-mock'

const run = promisify(execFile)
const fixture = { root: '', dir: '', projectId: '', head: '' }

async function git(args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd: fixture.dir })
  return String(stdout).trim()
}

beforeEach(async () => {
  fixture.root = await fsp.mkdtemp(path.join(os.tmpdir(), 'prjct-anchors-'))
  fixture.dir = path.join(fixture.root, 'proj')
  await fsp.mkdir(path.join(fixture.dir, '.prjct'), { recursive: true })
  fixture.projectId = `anc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await fsp.writeFile(
    path.join(fixture.dir, '.prjct', 'prjct.config.json'),
    JSON.stringify({ projectId: fixture.projectId, dataPath: fixture.root })
  )
  patchPathManager(fixture.root)
  prjctDb.run(fixture.projectId, 'SELECT 1 WHERE 1=0')
  await git(['init', '-q'])
  await git(['config', 'user.email', 't@t'])
  await git(['config', 'user.name', 't'])
  await fsp.mkdir(path.join(fixture.dir, 'src'), { recursive: true })
  await fsp.writeFile(path.join(fixture.dir, 'src', 'thing.ts'), 'export const thing = 1\n')
  await git(['add', '.'])
  await git(['commit', '-q', '-m', 'seed'])
  fixture.head = await git(['rev-parse', 'HEAD'])
})

afterEach(async () => {
  restorePathManager()
  await fsp.rm(fixture.root, { recursive: true, force: true }).catch(() => {})
})

const byContent = (needle: string) =>
  projectMemory.recall(fixture.projectId, { limit: 50 }).find((e) => e.content.includes(needle))

describe('write-time anchors', () => {
  it('binds a file-tagged capture to HEAD', async () => {
    expect((await resolveAnchors(fixture.dir, fixture.projectId, 'x')).commit).toBe(fixture.head)
    await projectMemory.remember(fixture.dir, {
      type: 'gotcha',
      content: 'thing.ts must export thing as a const, never a let',
      tags: { file: 'src/thing.ts' },
      projectId: fixture.projectId,
      requireWrite: true,
    })
    const entry = byContent('never a let')
    expect(entry?.tags.commit).toBe(fixture.head)
    expect(entry?.staleAt).toBeUndefined()
  })
})

describe('anchor sweep', () => {
  it('marks stale when the file is gone, un-marks when it is back, and demotes in recall', async () => {
    await projectMemory.remember(fixture.dir, {
      type: 'gotcha',
      content: 'thing.ts anchored gotcha that will go stale',
      tags: { file: 'src/thing.ts' },
      projectId: fixture.projectId,
      requireWrite: true,
    })
    // No file mention: otherwise file inference would anchor this one too.
    await projectMemory.remember(fixture.dir, {
      type: 'gotcha',
      content: 'fresh gotcha with no anchor problem at all',
      projectId: fixture.projectId,
      requireWrite: true,
    })

    // Anchor intact → nothing stale.
    expect((await markStaleMemoryAnchors(fixture.projectId, fixture.dir)).markedStale).toBe(0)

    // Delete + commit → the anchored entry goes stale.
    await fsp.rm(path.join(fixture.dir, 'src', 'thing.ts'))
    await git(['add', '-A'])
    await git(['commit', '-q', '-m', 'remove thing'])
    const swept = await markStaleMemoryAnchors(fixture.projectId, fixture.dir)
    expect(swept.markedStale).toBe(1)
    expect(staleAnchorCount(fixture.projectId)).toBe(1)

    const stale = byContent('will go stale')!
    expect(stale.staleAt).toBeTruthy()
    expect(formatMemoryDigestLine(stale, { minTeaser: 10, maxTeaser: 80 })).toContain(
      `[stale@${fixture.head.slice(0, 7)}]`
    )
    expect(formatMemoryMd([stale], { compact: true })).toContain('anchor gone')

    // Recall: the stale entry is served after the fresh one.
    const recalled = await enrichedRecall(fixture.dir, fixture.projectId, {
      topic: 'gotcha',
      limit: 10,
      recordAttribution: false,
    })
    const ids = recalled.map((e) => e.id)
    const freshId = byContent('no anchor problem')!.id
    expect(ids).toContain(freshId)
    expect(ids).toContain(stale.id)
    expect(ids.indexOf(freshId)).toBeLessThan(ids.indexOf(stale.id))

    // Restore the file → the sweep clears the mark.
    await fsp.writeFile(path.join(fixture.dir, 'src', 'thing.ts'), 'export const thing = 2\n')
    const cleared = await markStaleMemoryAnchors(fixture.projectId, fixture.dir)
    expect(cleared.cleared).toBe(1)
    expect(byContent('will go stale')?.staleAt).toBeUndefined()
  })

  it('keeps a renamed file valid', async () => {
    await projectMemory.remember(fixture.dir, {
      type: 'gotcha',
      content: 'thing.ts survives a rename',
      tags: { file: 'src/thing.ts' },
      projectId: fixture.projectId,
      requireWrite: true,
    })
    await git(['mv', 'src/thing.ts', 'src/renamed.ts'])
    await git(['commit', '-q', '-m', 'rename'])
    expect((await markStaleMemoryAnchors(fixture.projectId, fixture.dir)).markedStale).toBe(0)
  })
})
