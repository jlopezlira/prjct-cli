/**
 * Incremental change detection — saveHashes must skip the DELETE-all +
 * re-INSERT rewrite when the diff is empty (every sync otherwise rewrote
 * the whole index_checksums table for zero effect).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { detectIncrementalChanges } from '../../services/sync/incremental'
import prjctDb from '../../storage/database'
import { patchPathManager, restorePathManager } from '../_setup/path-manager-mock'

const fixture: {
  tmpRoot: string
  projectPath: string
  projectId: string
} = {
  tmpRoot: '',
  projectPath: '',
  projectId: '',
}

const SENTINEL = 'SENTINEL-no-rewrite'

const metaDoc = (): { fileCount: number; builtAt: string } | null =>
  prjctDb.getDoc(fixture.projectId, 'file-hashes-meta')

const detect = (isFullSync: boolean) =>
  detectIncrementalChanges({
    projectId: fixture.projectId,
    projectPath: fixture.projectPath,
    isFullSync,
    changedFilesHint: undefined,
  })

beforeEach(async () => {
  fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-incr-'))
  fixture.projectPath = path.join(fixture.tmpRoot, 'proj')
  await fs.mkdir(fixture.projectPath, { recursive: true })
  await fs.writeFile(path.join(fixture.projectPath, 'a.ts'), 'export const a = 1\n')
  await fs.writeFile(path.join(fixture.projectPath, 'b.ts'), 'export const b = 1\n')
  fixture.projectId = `test-incr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  patchPathManager(fixture.tmpRoot)
})

afterEach(async () => {
  restorePathManager()
  await fs.rm(fixture.tmpRoot, { recursive: true, force: true }).catch(() => {})
})

describe('detectIncrementalChanges — hash persistence', () => {
  it('skips the hash rewrite when the diff is empty', async () => {
    const first = await detect(true)
    expect(first.shouldRebuildIndexes).toBe(true)
    expect(metaDoc()?.fileCount).toBe(2)

    // A real saveHashes call rewrites this doc with a fresh builtAt.
    prjctDb.setDoc(fixture.projectId, 'file-hashes-meta', { fileCount: 2, builtAt: SENTINEL })

    const second = await detect(false)
    expect(second.incrementalInfo?.filesChanged).toBe(0)
    expect(second.shouldRebuildIndexes).toBe(false)
    expect(metaDoc()?.builtAt).toBe(SENTINEL)
  })

  it('persists new hashes when a file actually changes', async () => {
    await detect(true)
    prjctDb.setDoc(fixture.projectId, 'file-hashes-meta', { fileCount: 2, builtAt: SENTINEL })

    // Different size AND content so mtime-granularity reuse cannot kick in.
    await fs.writeFile(path.join(fixture.projectPath, 'a.ts'), 'export const a = 123456789\n')
    const result = await detect(false)
    expect(result.incrementalInfo?.filesChanged).toBe(1)
    expect(metaDoc()?.builtAt).not.toBe(SENTINEL)
  })
})
